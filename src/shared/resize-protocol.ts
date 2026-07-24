/**
 * Renderer ↔ pty-server terminal resize protocol.
 *
 * The renderer reports its terminal geometry over the PTY WebSocket as an
 * OSC-style in-band sequence: `ESC ] resize ; cols ; rows BEL`. The bun side
 * intercepts it before forwarding input to the PTY. Encoder and parser live
 * here — the single definition both sides import — so the wire format cannot
 * drift between the renderer and the pty-server.
 */

export const RESIZE_SEQUENCE_PREFIX = "\x1b]resize;";

const RESIZE_SEQUENCE_RE = /\x1b\]resize;(\d+);(\d+)\x07/;

/** Encode a terminal geometry report for the PTY WebSocket. */
export function encodeResizeSequence(cols: number, rows: number): string {
	return `${RESIZE_SEQUENCE_PREFIX}${cols};${rows}\x07`;
}

/** True when `data` starts a resize report (and must not reach the PTY). */
export function isResizeSequence(data: string): boolean {
	return data.startsWith(RESIZE_SEQUENCE_PREFIX);
}

/**
 * Parse a resize report. Returns null for a malformed sequence — callers
 * that already checked isResizeSequence() still swallow the message then.
 */
export function parseResizeSequence(data: string): { cols: number; rows: number } | null {
	const match = data.match(RESIZE_SEQUENCE_RE);
	if (!match) return null;
	return { cols: Number(match[1]), rows: Number(match[2]) };
}

/**
 * Negotiate one PTY geometry from the sizes reported by every attached client:
 * the smallest positive value per axis, independently. Null means no client
 * reported a usable size, so no geometry should be applied.
 *
 * Deliberately lives here and not in `pty-server.ts`: importing that module
 * starts the PTY WebSocket server at load time, so a test-only or
 * backend-neutral caller that only wanted this helper would never exit.
 */
export function smallestClientSize(
	sizes: ReadonlyArray<{ cols?: number; rows?: number }>,
): { cols: number; rows: number } | null {
	let minCols = Infinity;
	let minRows = Infinity;
	for (const { cols, rows } of sizes) {
		if (typeof cols === "number" && cols > 0) minCols = Math.min(minCols, cols);
		if (typeof rows === "number" && rows > 0) minRows = Math.min(minRows, rows);
	}
	if (minCols === Infinity || minRows === Infinity) return null;
	return { cols: minCols, rows: minRows };
}
