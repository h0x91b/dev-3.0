// Per-project polling cadences for the background git pollers (merge detection,
// PR promotion). The active board — the project the renderer is currently
// viewing, while the app is in the foreground — is checked every base tick;
// every other off-screen project is checked far less often.
//
// This is the fix for the git-process storm: previously every project on disk —
// often 30+ worktrees across several repos — was hit with `git fetch` + patch-id
// on every 60s tick regardless of what the user was looking at, saturating the
// CPU and stalling the main loop for seconds at a time.
//
// Kept dependency-free (no electrobun/pty imports) so the throttle decision can
// be unit-tested without a real app process.

export const ACTIVE_PROJECT_MERGE_INTERVAL_MS = 60_000;
export const BACKGROUND_PROJECT_MERGE_INTERVAL_MS = 10 * 60_000;
export const ACTIVE_PROJECT_PR_INTERVAL_MS = 5 * 60_000;
export const BACKGROUND_PROJECT_PR_INTERVAL_MS = 15 * 60_000;

// A project counts as "due" slightly before its nominal interval so that an
// active project (interval == base tick) is never skipped by timer drift.
export const DUE_TOLERANCE_MS = 10_000;

/**
 * Decide whether a project's per-task git work is due to run this tick.
 * Pure (time/context injected) so the throttling can be unit-tested without
 * spawning git or controlling the wall clock.
 */
export function isProjectDueForCheck(params: {
	projectId: string;
	activeProjectId: string | null;
	foreground: boolean;
	lastRunMs: number;
	nowMs: number;
	activeIntervalMs: number;
	backgroundIntervalMs: number;
}): boolean {
	const isActive = params.foreground && params.projectId === params.activeProjectId;
	const interval = isActive ? params.activeIntervalMs : params.backgroundIntervalMs;
	return params.nowMs - params.lastRunMs >= interval - DUE_TOLERANCE_MS;
}

/** Drop throttle bookkeeping for projects that no longer exist on disk. */
export function pruneLastRun(map: Map<string, number>, liveProjectIds: Set<string>): void {
	for (const id of [...map.keys()]) {
		if (!liveProjectIds.has(id)) map.delete(id);
	}
}
