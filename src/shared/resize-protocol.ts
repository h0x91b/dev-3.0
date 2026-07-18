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
