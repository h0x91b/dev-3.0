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
// A token bucket keeps the stream far below that ceiling. What the bucket cannot
// pass RIGHT NOW is held in a bounded backlog and drained at the same rate,
// rather than thrown away: dropping it is what made a hard flick stop short of
// where the finger went, which reads as a torn scroll rather than a slow one.
//
// The backlog stays bounded, and that bound is the original intent kept intact —
// a scroll the app cannot keep up with must end shortly after the finger stops,
// never coast for seconds. Reversing direction clears it outright: those lines
// would scroll the wrong way by the time they went out.

/** Sustained reports per second (~1.8 KB/s of SGR mouse sequences). */
export const WHEEL_REPORTS_PER_SECOND = 150;
/** Ceiling on a single flush (~192 bytes) so one write never approaches 1 KB. */
export const WHEEL_REPORT_BURST = 16;
/** Most lines the backlog may hold — about 0.6 s of drain at the sustained rate. */
export const WHEEL_BACKLOG_MAX = 96;
/**
 * How often the caller re-offers the backlog to the bucket. Short enough that a
 * drain never looks stepped, long enough that the bucket has tokens each tick
 * (at 150/s a 12 ms tick is worth ~1.8 reports).
 */
export const WHEEL_DRAIN_INTERVAL_MS = 12;

/** Which way queued lines scroll; 0 when nothing is queued. */
export type WheelDirection = -1 | 0 | 1;

export interface WheelPacer {
	/**
	 * How many of `requested` reports go out now. Whatever the bucket cannot pass
	 * joins the backlog (bounded, and cleared when `direction` reverses).
	 */
	take(requested: number, direction: WheelDirection, now: number): number;
	/** How many backlog reports may go out now. */
	drain(now: number): number;
	/** Lines still queued. */
	pending(): number;
	/** Which way the queued lines scroll. */
	direction(): WheelDirection;
	/** Forget the backlog — a new gesture, or the pane losing the wheel. */
	reset(): void;
}

export function createWheelPacer(
	ratePerSecond: number = WHEEL_REPORTS_PER_SECOND,
	burst: number = WHEEL_REPORT_BURST,
	backlogMax: number = WHEEL_BACKLOG_MAX,
): WheelPacer {
	let tokens = burst;
	let lastRefill: number | null = null;
	let backlog = 0;
	let backlogDirection: WheelDirection = 0;

	function refill(now: number): void {
		if (lastRefill !== null && now > lastRefill) {
			tokens = Math.min(burst, tokens + ((now - lastRefill) / 1000) * ratePerSecond);
		}
		lastRefill = now;
	}

	function spend(requested: number): number {
		if (requested <= 0) return 0;
		const allowed = Math.min(requested, burst, Math.floor(tokens));
		tokens -= allowed;
		return allowed;
	}

	return {
		take(requested, direction, now) {
			if (requested <= 0 || direction === 0) return 0;
			refill(now);
			// The finger turned around: queued lines now point the wrong way.
			if (backlogDirection !== 0 && backlogDirection !== direction) backlog = 0;
			backlogDirection = direction;
			// Order matters: the backlog is older than this event and goes first, or a
			// sustained scroll would deliver its lines out of order.
			const fromBacklog = spend(backlog);
			backlog -= fromBacklog;
			const fromRequest = spend(requested);
			backlog = Math.min(backlogMax, backlog + (requested - fromRequest));
			if (backlog === 0) backlogDirection = 0;
			return fromBacklog + fromRequest;
		},
		drain(now) {
			if (backlog <= 0) return 0;
			refill(now);
			const allowed = spend(backlog);
			backlog -= allowed;
			if (backlog === 0) backlogDirection = 0;
			return allowed;
		},
		pending: () => backlog,
		direction: () => backlogDirection,
		reset() {
			backlog = 0;
			backlogDirection = 0;
		},
	};
}
