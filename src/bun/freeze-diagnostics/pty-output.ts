/**
 * The last terminal output each PTY WebSocket client was sent, kept in memory
 * only while freeze capture is on, so a renderer that hangs inside a terminal
 * write leaves a replayable candidate input behind. Dependency-free on purpose:
 * `pty-server.ts` imports it on its hot send path.
 */

export const PTY_OUTPUT_RING_CHARS = 64 * 1024;
export const PTY_OUTPUT_MAX_CLIENTS = 32;
/** Two missed hidden-window beats (~3 s cadence): pin before a stuck socket's later output evicts the trigger. */
export const PTY_OUTPUT_PIN_AFTER_MS = 6_000;

export interface PtyOutputChunk {
	at: number;
	text: string;
}

export interface PtyOutputClientRecord {
	sessionKey: string;
	firstAt: number;
	lastAt: number;
	sentChars: number;
	droppedChars: number;
	chunks: PtyOutputChunk[];
	/** The ring as it stood when renderer heartbeats first went stale, before later output could evict it. */
	pinned: { at: number; chunks: PtyOutputChunk[] } | null;
}

interface Ring extends PtyOutputClientRecord {
	chars: number;
}

export function createPtyOutputRecorder(limits = { ringChars: PTY_OUTPUT_RING_CHARS, maxClients: PTY_OUTPUT_MAX_CLIENTS }) {
	let enabled = false;
	const rings = new Map<object, Ring>();

	function evictOldestClient() {
		let oldest: object | null = null;
		let oldestAt = Infinity;
		for (const [client, ring] of rings) {
			if (ring.lastAt < oldestAt) { oldest = client; oldestAt = ring.lastAt; }
		}
		if (oldest) rings.delete(oldest);
	}

	function record(client: object, sessionKey: string, text: string, at = Date.now()) {
		if (!enabled || !text) return;
		let ring = rings.get(client);
		if (!ring) {
			if (rings.size >= limits.maxClients) evictOldestClient();
			ring = { sessionKey, firstAt: at, lastAt: at, sentChars: 0, droppedChars: 0, chunks: [], pinned: null, chars: 0 };
			rings.set(client, ring);
		}
		// A single chunk larger than the ring keeps only its tail; the loss is counted, never hidden.
		const kept = text.length > limits.ringChars ? text.slice(-limits.ringChars) : text;
		ring.droppedChars += text.length - kept.length;
		ring.chunks.push({ at, text: kept });
		ring.chars += kept.length;
		ring.sentChars += text.length;
		ring.lastAt = at;
		while (ring.chars > limits.ringChars && ring.chunks.length > 1) {
			const evicted = ring.chunks.shift()!;
			ring.chars -= evicted.text.length;
			ring.droppedChars += evicted.text.length;
		}
	}

	function forget(client: object) {
		rings.delete(client);
	}

	/** Freeze every ring once per stale episode; the first pin of an episode wins. */
	function pin(at: number) {
		for (const ring of rings.values()) ring.pinned ??= { at, chunks: ring.chunks.slice() };
	}

	function unpin() {
		for (const ring of rings.values()) ring.pinned = null;
	}

	/** Most recently written client first. */
	function snapshot(): PtyOutputClientRecord[] {
		return [...rings.values()]
			.sort((a, b) => b.lastAt - a.lastAt)
			.map((ring) => ({
				sessionKey: ring.sessionKey, firstAt: ring.firstAt, lastAt: ring.lastAt,
				sentChars: ring.sentChars, droppedChars: ring.droppedChars,
				chunks: ring.chunks.slice(), pinned: ring.pinned,
			}));
	}

	function setEnabled(value: boolean) {
		enabled = value;
		if (!value) rings.clear();
	}

	return { record, forget, pin, unpin, snapshot, setEnabled, isEnabled: () => enabled };
}

/** The one recorder the PTY server writes into and freeze capture reads from. */
export const ptyOutputRecorder = createPtyOutputRecorder();
