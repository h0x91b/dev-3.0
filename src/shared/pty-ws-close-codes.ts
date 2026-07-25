/**
 * Close codes the PTY WebSocket server sends, and which of them are final.
 *
 * A final verdict must NOT be retried. The terminal view resets its backoff on
 * `onopen`, and the server accepts the upgrade before rejecting the session — so
 * a retried `UNKNOWN_SESSION` reconnects once a second forever and buries the
 * log in `WS connection to unknown session` (observed on Windows, where a task
 * launch that fails leaves exactly this dangling terminal view).
 */
export const PTY_WS_CLOSE = {
	MISSING_SESSION: 4000,
	UNKNOWN_SESSION: 4001,
} as const;

const FINAL_CODES: readonly number[] = [PTY_WS_CLOSE.MISSING_SESSION, PTY_WS_CLOSE.UNKNOWN_SESSION];

/** True when the server will answer identically no matter how often we retry. */
export function isFinalPtyCloseCode(code: number): boolean {
	return FINAL_CODES.includes(code);
}
