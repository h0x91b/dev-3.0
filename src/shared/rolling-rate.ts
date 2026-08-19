/**
 * Per-second counters over a tumbling window.
 *
 * Both perf probes need the same thing — "how many of these happened in the last
 * second" — and both are read by a poller, not by a timer of their own. A window
 * that stayed open longer than {@link ROLLING_WINDOW_MS} is scaled by the real
 * elapsed time rather than reported raw: four seconds of events reported as a
 * one-second rate would claim four times what happened.
 */

export const ROLLING_WINDOW_MS = 1000;

export interface RollingRate<K extends string> {
	/** Count `n` more of `key` in the window that is open now. */
	add(key: K, n?: number): void;
	/** The last window that closed, as events per second. */
	read(): Record<K, number>;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
	const out = {} as Record<K, number>;
	for (const key of keys) out[key] = 0;
	return out;
}

export function createRollingRate<K extends string>(
	keys: readonly K[],
	now: () => number = () => Date.now(),
	windowMs: number = ROLLING_WINDOW_MS,
): RollingRate<K> {
	let current = zeroed(keys);
	let reported = zeroed(keys);
	let windowStart = now();

	function roll(at: number): void {
		const elapsed = at - windowStart;
		if (elapsed < windowMs) return;
		const scale = windowMs / elapsed;
		const next = zeroed(keys);
		for (const key of keys) next[key] = Math.round(current[key] * scale);
		reported = next;
		current = zeroed(keys);
		windowStart = at;
	}

	return {
		add(key, n = 1) {
			if (!Number.isFinite(n) || n <= 0) return;
			roll(now());
			current[key] += n;
		},
		read() {
			roll(now());
			return { ...reported };
		},
	};
}
