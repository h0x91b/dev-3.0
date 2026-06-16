// Visibility-aware polling.
//
// Plain setInterval/setTimeout pollers keep firing while the app is hidden and,
// worse, every pending timer fires together the moment the machine wakes from
// sleep — a thundering herd that, for git-status pollers, each spawn `git fetch`
// + `gh` + a fistful of local git commands. This helper:
//   - never schedules a tick while the document is hidden,
//   - runs exactly one refresh when the app becomes visible again,
//   - spreads ticks with jitter so N panels don't align on the same instant,
//   - never overlaps runs (awaits the previous tick before scheduling the next).

export interface VisibilityAwarePollOptions {
	fn: () => void | Promise<void>;
	intervalMs: number;
	/** Symmetric jitter as a fraction of intervalMs (0..1). Default 0.2 (±20%). */
	jitterRatio?: number;
	/** Run `fn` immediately on start (when visible). Default true. */
	runOnStart?: boolean;
	/** Injectable RNG for deterministic tests. Default Math.random. */
	random?: () => number;
}

/** Next delay with symmetric jitter in [intervalMs*(1-r), intervalMs*(1+r)]. */
export function computeJitteredDelay(intervalMs: number, jitterRatio: number, random: () => number): number {
	const r = Math.max(0, Math.min(1, jitterRatio));
	const factor = 1 + (random() * 2 - 1) * r;
	return Math.max(0, Math.round(intervalMs * factor));
}

/**
 * Start a visibility-aware poll. Returns a cleanup function that stops the poll
 * and detaches the visibilitychange listener.
 */
export function startVisibilityAwarePoll(opts: VisibilityAwarePollOptions): () => void {
	const { fn, intervalMs } = opts;
	const jitterRatio = opts.jitterRatio ?? 0.2;
	const runOnStart = opts.runOnStart ?? true;
	const random = opts.random ?? Math.random;

	let timer: ReturnType<typeof setTimeout> | null = null;
	let cancelled = false;
	let running = false;
	// Set when a refresh is requested (e.g. on wake) while a tick is already in
	// flight, so we run one more immediately on completion instead of losing it.
	let refreshQueued = false;

	const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function schedule() {
		clearTimer();
		if (cancelled || isHidden()) return;
		timer = setTimeout(tick, computeJitteredDelay(intervalMs, jitterRatio, random));
	}

	async function tick() {
		timer = null;
		if (cancelled || isHidden()) return;
		// A run is already in flight: remember to refresh again right after it,
		// rather than dropping this request (the wake-refresh case).
		if (running) {
			refreshQueued = true;
			return;
		}
		running = true;
		try {
			await fn();
		} finally {
			running = false;
			const wantImmediate = refreshQueued && !cancelled && !isHidden();
			refreshQueued = false;
			if (!cancelled) {
				if (wantImmediate) void tick();
				else schedule();
			}
		}
	}

	function onVisibility() {
		if (cancelled) return;
		if (isHidden()) {
			clearTimer();
		} else {
			void tick();
		}
	}

	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibility);
	}

	if (runOnStart && !isHidden()) {
		void tick();
	} else {
		schedule();
	}

	return () => {
		cancelled = true;
		clearTimer();
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", onVisibility);
		}
	};
}
