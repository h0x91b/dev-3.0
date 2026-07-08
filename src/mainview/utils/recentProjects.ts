// MRU (most-recently-used) cache of project jumps, backing the Cmd/Ctrl+K
// quick-switch palette's "recent first" ordering. A jump = any navigation that
// lands on a project, recorded centrally at App's `commitNavigation` — so the
// palette, Cmd+1..9 / Cmd+Shift+1..9, the `g`-prefix go-to, a Dashboard card
// click, terminal toggles, and any future entry point are all covered. The list
// is an ordered array of project IDs, most-recent first, persisted in
// localStorage and capped so it never grows unbounded.

const LS_KEY = "dev3-recent-projects-v1";
// Parallel map of projectId → last-BOARD-VIEW epoch ms, so the Cmd+K "Both" mode
// can interleave a project into the task date-buckets by *when its board was last
// displayed*. Only viewing the whole project's board counts — opening a task
// inside a project does NOT (the task is already its own row in the list). Kept
// separate from the ordered id list above.
const LS_TIMES_KEY = "dev3-recent-projects-at-v1";
// taskId → last-OPENED epoch ms. A task's palette recency is max(updatedAt,
// last-opened), so a task you opened/worked in today lands in "Today" even if
// its record (status/notes) wasn't modified — updatedAt alone misses terminal work.
const LS_TASK_TIMES_KEY = "dev3-recent-tasks-at-v1";
const MAX_ENTRIES = 16;
const TASK_MAX_ENTRIES = 40;

/** Read an `id → epoch ms` access map from localStorage. Tolerates corrupt storage. */
function readAccessMap(lsKey: string): Record<string, number> {
	try {
		const raw = localStorage.getItem(lsKey);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [id, ts] of Object.entries(parsed)) {
			if (typeof ts === "number" && Number.isFinite(ts)) out[id] = ts;
		}
		return out;
	} catch {
		return {};
	}
}

/** Stamp `id`'s access time now, forcing it to survive the `cap` prune, then persist. */
function stampAccess(lsKey: string, id: string, cap: number): void {
	if (!id) return;
	try {
		const times = readAccessMap(lsKey);
		times[id] = Date.now();
		const kept = Object.fromEntries(
			Object.entries(times)
				.sort((a, b) => (a[0] === id ? -1 : b[0] === id ? 1 : b[1] - a[1]))
				.slice(0, cap),
		);
		localStorage.setItem(lsKey, JSON.stringify(kept));
	} catch {
		/* ignore — recency is best-effort */
	}
}

/** Read the MRU project-id list, most-recent first. Tolerates corrupt storage. */
export function getRecentProjectIds(): string[] {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	}
}

/** projectId → last-board-view epoch ms. Tolerates corrupt storage. */
export function getProjectAccessTimes(): Record<string, number> {
	return readAccessMap(LS_TIMES_KEY);
}

/** taskId → last-opened epoch ms. Tolerates corrupt storage. */
export function getTaskAccessTimes(): Record<string, number> {
	return readAccessMap(LS_TASK_TIMES_KEY);
}

/**
 * Record a jump to `projectId`, moving it to the front of the MRU list. Fired on
 * ANY navigation that lands on a project (incl. opening a task in it) — this
 * backs the Projects-mode ordering. It does NOT stamp the board-view access time
 * (see `recordProjectBoardView`).
 */
export function recordProjectJump(projectId: string): void {
	if (!projectId) return;
	const next = [projectId, ...getRecentProjectIds().filter((id) => id !== projectId)].slice(0, MAX_ENTRIES);
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(next));
	} catch {
		/* ignore — recency is best-effort */
	}
}

/**
 * Stamp `projectId`'s last-board-view time (for the Cmd+K "Both" interleave).
 * Call this ONLY when the user displays the project's board itself — not when
 * they open a task within the project. Caps the map to the 16 most-recent.
 */
export function recordProjectBoardView(projectId: string): void {
	stampAccess(LS_TIMES_KEY, projectId, MAX_ENTRIES);
}

/**
 * Stamp `taskId`'s last-opened time (for the Cmd+K task recency). Call this when
 * the user navigates to a task (fullscreen or the split task view) — its palette
 * recency becomes max(updatedAt, last-opened), so a task you worked in today
 * lands in "Today" even without a record change.
 */
export function recordTaskVisit(taskId: string): void {
	stampAccess(LS_TASK_TIMES_KEY, taskId, TASK_MAX_ENTRIES);
}

/**
 * Order `projects` for the quick-switch palette: the ones jumped to most
 * recently come first (in MRU order), then the rest in their original
 * (board) order. Input order is otherwise preserved, so callers should pass
 * projects already in board order. Pure — does not touch storage beyond the
 * passed-in `recentIds`.
 */
export function orderByRecency<T extends { id: string }>(projects: T[], recentIds: string[]): T[] {
	if (recentIds.length === 0) return projects;
	const byId = new Map(projects.map((p) => [p.id, p]));
	const recent: T[] = [];
	const seen = new Set<string>();
	for (const id of recentIds) {
		const p = byId.get(id);
		if (p && !seen.has(id)) {
			recent.push(p);
			seen.add(id);
		}
	}
	const rest = projects.filter((p) => !seen.has(p.id));
	return [...recent, ...rest];
}
