// Per-task polling schedule for the background git pollers (merge detection, PR
// promotion). Two problems are solved here:
//
//   1. The git-process storm: every project on disk — often 30+ worktrees across
//      several repos — was hit with `git fetch` + patch-id on every tick
//      regardless of what was on screen, stalling the main loop. Each task now
//      carries its own next-due time; the project the renderer is actively
//      viewing (foreground) is polled at full cadence, everything else far less.
//
//   2. The thundering herd. Equal intervals make many tasks come due on the very
//      same tick (and, worse, after the laptop wakes from sleep EVERY overdue
//      task fires at once). So each scheduled time gets random jitter, fresh /
//      post-wake tasks are spread across their whole interval window, and a tick
//      that arrives suspiciously late (host was asleep) re-spreads instead of
//      firing everything together.
//
// Kept dependency-free (no electrobun/pty imports) and time/RNG-injected so the
// scheduling can be unit-tested without a real app process or wall clock.

export const ACTIVE_PROJECT_MERGE_INTERVAL_MS = 60_000;
export const BACKGROUND_PROJECT_MERGE_INTERVAL_MS = 10 * 60_000;
export const ACTIVE_PROJECT_PR_INTERVAL_MS = 5 * 60_000;
export const BACKGROUND_PROJECT_PR_INTERVAL_MS = 15 * 60_000;

// Base tick of each poller's setInterval. Used for wake detection.
export const MERGE_POLL_INTERVAL_MS = 60_000;
export const PR_POLL_INTERVAL_MS = 5 * 60_000;

// Random drift added on top of the interval when rescheduling, so two checks
// that once landed on the same tick gradually separate and never re-synchronise.
export const SCHEDULE_JITTER_MS = 30_000;

// A poll tick arriving more than this multiple of its base interval late means
// the host was suspended (laptop sleep / lid closed). Rather than letting every
// overdue task fire in one synchronized burst, we re-spread them.
export const WAKE_GAP_MULTIPLE = 2.5;

/** Cadence for a task this tick: full speed only for the on-screen project. */
export function intervalForTask(
	isActiveForeground: boolean,
	activeIntervalMs: number,
	backgroundIntervalMs: number,
): number {
	return isActiveForeground ? activeIntervalMs : backgroundIntervalMs;
}

/** Steady-state next-due: one interval out, plus a small random drift. */
export function nextDueAfterRun(nowMs: number, intervalMs: number, random: () => number = Math.random): number {
	return nowMs + intervalMs + Math.floor(random() * SCHEDULE_JITTER_MS);
}

/**
 * First-sight / post-wake next-due: a random point spread across the whole
 * interval window, so a batch of tasks that appear (or wake) together lands on
 * different ticks instead of all at once.
 */
export function staggeredDue(nowMs: number, intervalMs: number, random: () => number = Math.random): number {
	return nowMs + Math.floor(random() * intervalMs);
}

export function isDue(nextDueMs: number, nowMs: number): boolean {
	return nowMs >= nextDueMs;
}

/** True when the gap since the previous tick implies the host was asleep. */
export function wasAsleep(gapMs: number, baseIntervalMs: number): boolean {
	return gapMs > baseIntervalMs * WAKE_GAP_MULTIPLE;
}

/** Drop scheduling state for tasks that no longer exist. */
export function pruneSchedule(map: Map<string, number>, liveIds: Set<string>): void {
	for (const id of [...map.keys()]) {
		if (!liveIds.has(id)) map.delete(id);
	}
}
