/**
 * How wide the PTY output batch window gets when a viewer's socket is behind.
 *
 * Over a Cloudflare tunnel a blind 16 ms broadcast piles frames into the socket
 * buffer faster than the link drains them, so the terminal animates smoothly but
 * behind reality. Widening the window throttles the send cadence instead.
 *
 * Nothing is ever dropped: the ANSI stream is stateful, so a discarded chunk
 * corrupts the screen. Output waits in `session.pendingData` and is coalesced.
 */

/** Below this many buffered bytes the socket is considered idle. */
export const PTY_BACKPRESSURE_LOW_WATER_BYTES = 64 * 1024;
/** At or above this, the window is at its maximum. */
export const PTY_BACKPRESSURE_HIGH_WATER_BYTES = 1024 * 1024;
/** Widest batch window under full backpressure. */
export const PTY_BATCH_INTERVAL_MAX_MS = 250;

/**
 * Interpolate the batch window between the normal cadence and the maximum,
 * linearly across the low/high water marks.
 */
export function batchWindowMs(bufferedBytes: number, baseIntervalMs: number): number {
	if (bufferedBytes < PTY_BACKPRESSURE_LOW_WATER_BYTES) return baseIntervalMs;
	if (bufferedBytes >= PTY_BACKPRESSURE_HIGH_WATER_BYTES) return PTY_BATCH_INTERVAL_MAX_MS;
	const span = PTY_BACKPRESSURE_HIGH_WATER_BYTES - PTY_BACKPRESSURE_LOW_WATER_BYTES;
	const progress = (bufferedBytes - PTY_BACKPRESSURE_LOW_WATER_BYTES) / span;
	return Math.round(baseIntervalMs + progress * (PTY_BATCH_INTERVAL_MAX_MS - baseIntervalMs));
}

/**
 * A backed-up socket must not also get the leading-edge flush — an immediate
 * send is exactly what it cannot absorb.
 */
export function isBackedUp(bufferedBytes: number): boolean {
	return bufferedBytes >= PTY_BACKPRESSURE_LOW_WATER_BYTES;
}
