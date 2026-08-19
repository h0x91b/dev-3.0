/**
 * Renderer → pty-server flow control for terminal output.
 *
 * **The problem this exists for.** Bun's PTY has no `pause()`, so the server
 * must keep reading the shell whatever the viewer is doing, and every socket
 * between them is loopback — `getBufferedAmount()` reads 0 while megabytes pile
 * up in the browser's own WebSocket receive queue. Measured under a full-screen
 * flood: the server sent 6.2 MB/s, the renderer consumed 0.95 MB/s, and the
 * server's own gauges saw no backlog at all. The screen then replayed minutes of
 * history in slow motion, which is worse than missing frames.
 *
 * The renderer is therefore the only party that can say how far behind it is. It
 * acknowledges bytes as it consumes them; `sent - acked` is the real backlog,
 * wherever it physically sits.
 *
 * **What the server does with it.** Past {@link PTY_DROP_HIGH_WATER_BYTES} it
 * throws the pending output away instead of queueing it, and once the viewer is
 * back under {@link PTY_DROP_RESUME_BYTES} it asks tmux to repaint the pane.
 * Discarding raw ANSI is normally corrupting — the stream is stateful — which is
 * exactly why this is tmux-only: tmux holds the authoritative screen and can
 * redraw it. Native sessions have no such source and are never dropped.
 */

/** OSC-style in-band ack, same shape as the resize report. */
export const PTY_ACK_PREFIX = "\x1b]dev3ack;";

const PTY_ACK_RE = /^\x1b\]dev3ack;(\d+)\x07$/;

/** Encode "I have consumed `bytes` in total on this socket". Cumulative, not a delta. */
export function encodeAckSequence(bytes: number): string {
	return `${PTY_ACK_PREFIX}${Math.max(0, Math.floor(bytes))}\x07`;
}

/** True when `data` is an ack (and must not reach the PTY as keystrokes). */
export function isAckSequence(data: string): boolean {
	return data.startsWith(PTY_ACK_PREFIX);
}

/**
 * Parse an ack. Returns null for anything malformed — callers that already
 * checked {@link isAckSequence} still swallow the message then, so a broken ack
 * costs flow control rather than typing garbage into the shell.
 */
export function parseAckSequence(data: string): number | null {
	const match = data.match(PTY_ACK_RE);
	if (!match) return null;
	const bytes = Number(match[1]);
	return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Backlog at which output starts being discarded.
 *
 * Sized so an honest viewer never trips it: at the ~1 MB/s a loaded renderer
 * sustains this is half a second behind, and it also absorbs the bytes an ack
 * round trip leaves in flight on a remote (tunnelled) viewer.
 */
export const PTY_DROP_HIGH_WATER_BYTES = 512 * 1024;

/** Backlog at which the viewer counts as caught up and gets its repaint. */
export const PTY_DROP_RESUME_BYTES = 64 * 1024;

/** One viewer's position in the stream. `acked` is null until it acks at all. */
export interface ViewerProgress {
	sent: number;
	acked: number | null;
}

/**
 * How far the furthest-behind viewer is, in bytes.
 *
 * A viewer that has never acked is skipped rather than counted as infinitely
 * behind: flow control is opt-in, so an older renderer or a plain WebSocket
 * client keeps the old never-drop behaviour instead of being starved.
 *
 * The maximum, not the average — output is one broadcast, so the slowest viewer
 * decides what everyone sees. Same rule the socket-buffer probe already uses.
 */
export function outstandingBytes(viewers: Iterable<ViewerProgress>): number {
	let worst = 0;
	for (const viewer of viewers) {
		if (viewer.acked === null) continue;
		const behind = viewer.sent - viewer.acked;
		if (behind > worst) worst = behind;
	}
	return worst;
}

/**
 * Whether to be dropping output, given the backlog and whether we already are.
 *
 * Hysteresis on purpose: one threshold would flap between dropping and sending
 * on every flush, so the screen would neither keep up nor stay still.
 */
export function shouldDropOutput(outstanding: number, alreadyDropping: boolean): boolean {
	if (alreadyDropping) return outstanding > PTY_DROP_RESUME_BYTES;
	return outstanding >= PTY_DROP_HIGH_WATER_BYTES;
}
