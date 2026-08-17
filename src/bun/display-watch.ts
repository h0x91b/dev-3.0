import type { DisplayLike } from "./window-state";

/**
 * Electrobun exposes no display-configuration and no sleep/wake event (Screen is
 * a poll-only API, and window events are limited to move/resize/focus/blur/close),
 * so both are inferred here from one cheap timer.
 */

export type DisplayChangeReason = "displays" | "wake";

/** Opaque timer handle — the global setInterval's return type differs per runtime. */
type TimerHandle = unknown;

export interface DisplayWatchOptions {
	getDisplays: () => DisplayLike[];
	onChange: (event: { reason: DisplayChangeReason; displays: DisplayLike[]; signature: string }) => void;
	intervalMs?: number;
	/** Injected in tests; the app uses the wall clock. */
	now?: () => number;
	setInterval?: (fn: () => void, ms: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
}

/** Stable text form of the whole display layout — geometry and scale both matter. */
export function displaySignature(displays: DisplayLike[]): string {
	return displays
		.map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor ?? 1}`)
		.sort()
		.join("|");
}

/**
 * Timers do not run while the machine is asleep, so a tick arriving much later
 * than scheduled is the wake signal. The multiplier keeps ordinary event-loop
 * stalls (GC, a busy machine) from being misread as a wake.
 */
const WAKE_GAP_MULTIPLIER = 3;

export const DISPLAY_WATCH_INTERVAL_MS = 5000;

/** Start polling; returns a stop function. */
export function startDisplayWatch(opts: DisplayWatchOptions): () => void {
	const intervalMs = opts.intervalMs ?? DISPLAY_WATCH_INTERVAL_MS;
	const now = opts.now ?? Date.now;
	const setTimer: (fn: () => void, ms: number) => TimerHandle =
		opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer: (handle: TimerHandle) => void =
		opts.clearInterval ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

	let signature = displaySignature(opts.getDisplays());
	let lastTick = now();

	const handle = setTimer(() => {
		const tick = now();
		const slept = tick - lastTick > intervalMs * WAKE_GAP_MULTIPLIER;
		lastTick = tick;

		const displays = opts.getDisplays();
		const next = displaySignature(displays);
		const changed = next !== signature;
		signature = next;

		// A sleep/wake cycle can end on the exact layout it started with, so the
		// signature alone would miss it — report the wake anyway. Both together
		// still report once: a changed layout is the more specific reason.
		if (changed) opts.onChange({ reason: "displays", displays, signature: next });
		else if (slept) opts.onChange({ reason: "wake", displays, signature: next });
	}, intervalMs);

	return () => clearTimer(handle);
}
