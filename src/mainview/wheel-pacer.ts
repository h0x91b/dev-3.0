// ── Wheel-report pacer ──
// A fast flick can accumulate dozens of scroll lines per wheel event, and the
// wheel handler turns every line into its own SGR mouse report (~12 bytes).
// Unpaced, that is several KB/s of escape sequences pushed into the pane's PTY.
//
// macOS hands a PTY reader at most 1022 bytes per read (measured). Once a
// busy TUI lets that much pile up, the next read lands mid-sequence, and an
// app that does not carry the unterminated prefix across chunks — Claude Code
// among them — prints the orphaned tail into its input box as literal text.
// See decision 175.
//
// A token bucket keeps the stream far below that ceiling. Excess lines are
// dropped rather than queued: a scroll the app cannot keep up with should end
// where the finger stopped, not keep coasting.

/** Sustained reports per second (~1.8 KB/s of SGR mouse sequences). */
export const WHEEL_REPORTS_PER_SECOND = 150;
/** Ceiling on a single flush (~192 bytes) so one write never approaches 1 KB. */
export const WHEEL_REPORT_BURST = 16;

export interface WheelPacer {
	/** How many of `requested` reports may be sent now; the rest are dropped. */
	take(requested: number, now: number): number;
}

export function createWheelPacer(
	ratePerSecond: number = WHEEL_REPORTS_PER_SECOND,
	burst: number = WHEEL_REPORT_BURST,
): WheelPacer {
	let tokens = burst;
	let lastRefill: number | null = null;

	return {
		take(requested, now) {
			if (requested <= 0) return 0;
			if (lastRefill !== null && now > lastRefill) {
				tokens = Math.min(burst, tokens + ((now - lastRefill) / 1000) * ratePerSecond);
			}
			lastRefill = now;
			const allowed = Math.min(requested, burst, Math.floor(tokens));
			tokens -= allowed;
			return allowed;
		},
	};
}
