// MRU (most-recently-used) cache of project jumps, backing the Cmd/Ctrl+K
// quick-switch palette's "recent first" ordering. A jump = any navigation that
// lands on a project, recorded centrally at App's `commitNavigation` — so the
// palette, Cmd+1..9 / Cmd+Shift+1..9, the `g`-prefix go-to, a Dashboard card
// click, terminal toggles, and any future entry point are all covered. The list
// is an ordered array of project IDs, most-recent first, persisted in
// localStorage and capped so it never grows unbounded.

const LS_KEY = "dev3-recent-projects-v1";
const MAX_ENTRIES = 16;

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

/** Record a jump to `projectId`, moving it to the front of the MRU list. */
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
