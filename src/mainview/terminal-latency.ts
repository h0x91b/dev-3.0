/**
 * Terminal latency probe — the number the "it feels laggy" reports are about.
 *
 * Before this there was no end-to-end instrumentation anywhere in the app, so
 * every latency claim (including the audit that produced it) was reasoning about
 * code rather than measurement. Four rolling distributions, sampled from the
 * terminal that is already running:
 *
 *  - `echo`   keystroke → the PTY's bytes back in the renderer. Everything
 *             outside the browser: socket, bun's batch window, tmux, the shell.
 *  - `paint`  keystroke → the first ghostty frame painted after those bytes were
 *             written. What the user actually waits for.
 *  - `write`  time inside `term.write()` — the WASM parse.
 *  - `frame`  time inside `renderer.render()` — the canvas cost per frame, the
 *             headroom any renderer work would buy.
 *
 * Only IDLE typing is sampled: a round trip is started by a single printable
 * keystroke after {@link QUIET_BEFORE_MS} of silence, so an agent streaming
 * output can never be mistaken for an echo. An unanswered keystroke is
 * abandoned after {@link SAMPLE_TIMEOUT_MS} rather than recorded as a huge one.
 *
 * Read it live from devtools or an automated browser session with
 * `window.__dev3TerminalLatency()`; a summary also goes to the backend log every
 * {@link REPORT_INTERVAL_MS}, which is what survives a restart.
 */

/** Samples kept per stage. At 60 fps `frame` covers the last ~4 seconds. */
export const MAX_SAMPLES = 240;
/** Silence required before a keystroke may start a round trip. */
export const QUIET_BEFORE_MS = 150;
/** A keystroke with no output after this is abandoned, not recorded. */
export const SAMPLE_TIMEOUT_MS = 1000;
/** How often a summary is pushed to the log sink. */
export const REPORT_INTERVAL_MS = 60_000;

export type LatencyStage = "echo" | "paint" | "write" | "frame";

const STAGES: readonly LatencyStage[] = ["echo", "paint", "write", "frame"];

export interface StageStats {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

export type LatencySnapshot = Record<LatencyStage, StageStats>;

export interface TerminalLatencyProbe {
	/** A keystroke left the terminal. Only a lone printable one starts a sample. */
	noteInput(data: string): void;
	/** Bytes arrived from the PTY, before they are written. */
	noteOutput(): void;
	/** How long `term.write()` took. */
	noteWrite(ms: number): void;
	/** A ghostty frame finished painting, and how long it took. */
	noteFrame(ms: number): void;
	snapshot(): LatencySnapshot;
	dispose(): void;
}

export interface ProbeOptions {
	/** Where a periodic summary goes. Omit to only keep it in memory. */
	report?: (snapshot: LatencySnapshot) => void;
	now?: () => number;
	reportIntervalMs?: number;
}

function emptyStats(): StageStats {
	return { count: 0, p50: 0, p95: 0, max: 0 };
}

/** Nearest-rank percentile over a copy, so the ring buffer keeps arrival order. */
export function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * A lone printable character — the only input whose echo is unambiguous. A paste
 * arrives as many characters, and a control sequence may produce no echo at all.
 */
export function isSamplableKeystroke(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

export function createTerminalLatencyProbe(opts: ProbeOptions = {}): TerminalLatencyProbe {
	const now = opts.now ?? (() => performance.now());
	const samples: Record<LatencyStage, number[]> = { echo: [], paint: [], write: [], frame: [] };

	/** Keystroke waiting for its echo. */
	let pendingInputAt: number | null = null;
	/** Echo that arrived and is waiting for the frame that shows it. */
	let pendingPaintFrom: number | null = null;
	let lastOutputAt = -Infinity;

	function push(stage: LatencyStage, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		const bucket = samples[stage];
		bucket.push(ms);
		if (bucket.length > MAX_SAMPLES) bucket.shift();
	}

	function snapshot(): LatencySnapshot {
		const out = {} as LatencySnapshot;
		for (const stage of STAGES) {
			const bucket = samples[stage];
			if (bucket.length === 0) {
				out[stage] = emptyStats();
				continue;
			}
			const sorted = [...bucket].sort((a, b) => a - b);
			out[stage] = {
				count: sorted.length,
				p50: round(percentile(sorted, 0.5)),
				p95: round(percentile(sorted, 0.95)),
				max: round(sorted[sorted.length - 1]),
			};
		}
		return out;
	}

	const reportEvery = opts.reportIntervalMs ?? REPORT_INTERVAL_MS;
	const timer = opts.report
		? setInterval(() => {
				const snap = snapshot();
				// Nothing happened in this window — an empty line every minute per pane
				// would drown the very log this is meant to make readable.
				if (snap.echo.count === 0 && snap.frame.count === 0) return;
				opts.report?.(snap);
			}, reportEvery)
		: null;

	return {
		noteInput(data) {
			if (!isSamplableKeystroke(data)) return;
			const at = now();
			// Typing into a stream of agent output: the next bytes are not this
			// keystroke's echo, so there is nothing honest to measure.
			if (at - lastOutputAt < QUIET_BEFORE_MS) return;
			pendingInputAt = at;
		},
		noteOutput() {
			const at = now();
			lastOutputAt = at;
			if (pendingInputAt === null) return;
			const elapsed = at - pendingInputAt;
			pendingInputAt = null;
			// The shell took too long to answer — that is the shell's latency, not ours.
			if (elapsed > SAMPLE_TIMEOUT_MS) return;
			push("echo", elapsed);
			pendingPaintFrom = at - elapsed;
		},
		noteWrite(ms) {
			push("write", ms);
		},
		noteFrame(ms) {
			push("frame", ms);
			if (pendingPaintFrom === null) return;
			const elapsed = now() - pendingPaintFrom;
			pendingPaintFrom = null;
			if (elapsed > SAMPLE_TIMEOUT_MS) return;
			push("paint", elapsed);
		},
		snapshot,
		dispose() {
			if (timer !== null) clearInterval(timer);
			pendingInputAt = null;
			pendingPaintFrom = null;
		},
	};
}

// ── Live read-out ────────────────────────────────────────────────────
// One global function rather than a panel: it needs no UI surface, works in
// devtools and in a scripted browser session alike, and reports every pane at
// once — which is the view an audit wants.

const liveProbes = new Map<string, TerminalLatencyProbe>();

declare global {
	interface Window {
		__dev3TerminalLatency?: () => Record<string, LatencySnapshot>;
	}
}

export function registerLatencyProbe(paneKey: string, probe: TerminalLatencyProbe): () => void {
	liveProbes.set(paneKey, probe);
	if (typeof window !== "undefined" && !window.__dev3TerminalLatency) {
		window.__dev3TerminalLatency = () => {
			const out: Record<string, LatencySnapshot> = {};
			for (const [key, live] of liveProbes) out[key] = live.snapshot();
			return out;
		};
	}
	return () => {
		if (liveProbes.get(paneKey) === probe) liveProbes.delete(paneKey);
	};
}

/** Test-only: drop every registered pane. */
export function __resetLatencyProbesForTests(): void {
	liveProbes.clear();
}
