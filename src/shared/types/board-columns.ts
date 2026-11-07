import type { TaskStatus } from "./task-status";
import { hasGitWorkflow, type Project } from "./project";
import type { CustomColumn } from "./labels-columns";

// ---- Board columns (single source of truth for column ordering + visibility) ----

/** Default built-in column order — custom columns are interspersed between these two halves. */
export const DEFAULT_BEFORE_CUSTOM_COLUMNS: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
];
export const DEFAULT_AFTER_CUSTOM_COLUMNS: TaskStatus[] = ["review-by-colleague", "completed", "cancelled"];
export const ALL_BUILTIN_COLUMNS: TaskStatus[] = [...DEFAULT_BEFORE_CUSTOM_COLUMNS, ...DEFAULT_AFTER_CUSTOM_COLUMNS];

/** One project's participation in a custom lane: which of ITS columns the lane stands for. */
export interface CustomLaneMember {
	projectId: string;
	columnId: string;
}

/**
 * A single board column ("lane"): either a built-in status column or a custom
 * one. A custom lane may stand for several projects' same-named columns at once
 * (the unified space board) — `col` is the representative used for name and
 * color, `members` says which project contributes which column id.
 */
export type BoardColumnSlot =
	| { type: "builtin"; status: TaskStatus }
	| { type: "custom"; col: CustomColumn; members: CustomLaneMember[] };

/**
 * Lane identity for merging same-named custom columns across projects: trimmed,
 * case-folded, inner whitespace collapsed. A stray capital must not split a lane.
 */
export function normalizeLaneName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The projects a board's columns are computed from. */
export type BoardProject = Pick<
	Project,
	"id" | "customColumns" | "columnOrder" | "peerReviewEnabled" | "builtinColumnAgents" | "kind" | "gitWorkflow"
>;

/**
 * Whether `lane` can accept a card belonging to `projectId`. Built-in statuses
 * are a global enum, so every card is placeable in every built-in lane; a merged
 * custom lane only accepts a card whose project actually owns that column.
 */
export function laneAcceptsProject(lane: BoardColumnSlot, projectId: string): boolean {
	return lane.type === "builtin" || lane.members.some((m) => m.projectId === projectId);
}

/** The custom-column id a drop on `lane` must write for a card of `projectId`. */
export function laneColumnIdForProject(lane: BoardColumnSlot, projectId: string): string | null {
	if (lane.type !== "custom") return null;
	return lane.members.find((m) => m.projectId === projectId)?.columnId ?? null;
}

/** Stable per-lane key: the representative custom column's id, or the status. */
export function laneKey(lane: BoardColumnSlot): string {
	return lane.type === "builtin" ? lane.status : lane.col.id;
}

/**
 * Returns every column a project's board renders, in effective display order,
 * respecting `columnOrder` and hiding columns that don't apply (virtual boards
 * have no AI/PR review; `peerReviewEnabled === false` hides PR review; AI review
 * hides when disabled). Single source of truth for the board's column layout —
 * see [[KanbanBoard]].
 *
 * Pure function of the project plus `opts.occupiedStatuses` — the built-in
 * statuses that currently hold at least one card. **A column holding tasks is
 * never hidden**, whatever the project config says: hiding it would drop those
 * cards off the board with no way to reach them (and it survives a restart,
 * which reads as data loss). Turning peer review off, or converting a board to
 * Operations, therefore leaves an occupied review column standing until it
 * empties out.
 */
function projectBoardColumns(
	project: BoardProject,
	opts: { occupiedStatuses?: ReadonlySet<TaskStatus> } = {},
): BoardColumnSlot[] {
	const cols = project.customColumns ?? [];
	const peerReviewEnabled = project.peerReviewEnabled !== false;
	// AI Review shows by default (on when builtinColumnAgents is unset or has a review-by-ai config).
	const aiReviewEnabled = project.builtinColumnAgents === undefined || !!project.builtinColumnAgents?.["review-by-ai"];
	const occupied = opts.occupiedStatuses;
	// Without the git workflow there is no diff or PR, so AI Review and PR Review are hidden.
	const gitless = !hasGitWorkflow(project);
	const shouldHide = (s: TaskStatus) =>
		!occupied?.has(s) && (
			(gitless && (s === "review-by-ai" || s === "review-by-colleague")) ||
			(s === "review-by-colleague" && !peerReviewEnabled) ||
			(s === "review-by-ai" && !aiReviewEnabled)
		);
	const filterBuiltin = (statuses: TaskStatus[]) => statuses.filter((s) => !shouldHide(s));
	const customSlot = (col: CustomColumn): BoardColumnSlot => ({
		type: "custom",
		col,
		members: [{ projectId: project.id, columnId: col.id }],
	});

	if (!project.columnOrder || project.columnOrder.length === 0) {
		return [
			...filterBuiltin(DEFAULT_BEFORE_CUSTOM_COLUMNS).map((s) => ({ type: "builtin" as const, status: s })),
			...cols.map(customSlot),
			...filterBuiltin(DEFAULT_AFTER_CUSTOM_COLUMNS).map((s) => ({ type: "builtin" as const, status: s })),
		];
	}

	const result: BoardColumnSlot[] = [];
	const used = new Set<string>();
	for (const id of project.columnOrder) {
		if ((ALL_BUILTIN_COLUMNS as string[]).includes(id) && shouldHide(id as TaskStatus)) {
			used.add(id);
			continue;
		}
		if ((ALL_BUILTIN_COLUMNS as string[]).includes(id)) {
			result.push({ type: "builtin", status: id as TaskStatus });
			used.add(id);
		} else {
			const col = cols.find((c) => c.id === id);
			if (col) {
				result.push(customSlot(col));
				used.add(id);
			}
		}
	}
	// review-by-ai: if missing from stored order, insert right before "review-by-user"
	// so it stays in the correct lifecycle position for existing users.
	if (!used.has("review-by-ai") && !shouldHide("review-by-ai")) {
		const reviewByUserIdx = result.findIndex((c) => c.type === "builtin" && c.status === "review-by-user");
		const slot: BoardColumnSlot = { type: "builtin", status: "review-by-ai" };
		if (reviewByUserIdx !== -1) result.splice(reviewByUserIdx, 0, slot);
		else result.push(slot);
		used.add("review-by-ai");
	}
	// review-by-colleague: if missing from stored order, insert right before "completed".
	if (!used.has("review-by-colleague") && !shouldHide("review-by-colleague")) {
		const completedIdx = result.findIndex((c) => c.type === "builtin" && c.status === "completed");
		const slot: BoardColumnSlot = { type: "builtin", status: "review-by-colleague" };
		if (completedIdx !== -1) result.splice(completedIdx, 0, slot);
		else result.push(slot);
		used.add("review-by-colleague");
	}
	// Append anything else missing (new built-ins, or new custom cols).
	for (const s of ALL_BUILTIN_COLUMNS) {
		if (!used.has(s) && !shouldHide(s)) result.push({ type: "builtin", status: s });
	}
	for (const col of cols) {
		if (!used.has(col.id)) result.push(customSlot(col));
	}
	return result;
}

/**
 * Every lane a board renders, in effective display order. The board's subject is
 * a SET of projects: exactly one for a project's own board (the output is then
 * `projectBoardColumns` untouched — the additive promise), several for a space's
 * unified board.
 *
 * Across several projects the lanes are the union: a built-in status shows if
 * any member project shows it, and custom columns with the same normalized name
 * merge into one lane carrying every contributing project's own column id (see
 * `laneColumnIdForProject`). Per-project column RENAMES are deliberately ignored
 * on a multi-project board — `customStatusLabels` cannot be reconciled between
 * two projects, so callers use dev3's canonical status names there.
 *
 * Order across projects is a merge that preserves each project's own relative
 * order: the first project lays down the spine, and each later project's unseen
 * lanes are inserted right after the lane that precedes them in ITS order.
 */
export function getBoardColumns(
	projects: BoardProject[],
	opts: { occupiedStatuses?: ReadonlySet<TaskStatus> } = {},
): BoardColumnSlot[] {
	if (projects.length === 0) return [];
	if (projects.length === 1) return projectBoardColumns(projects[0], opts);

	const keyOf = (slot: BoardColumnSlot) =>
		slot.type === "builtin" ? `b:${slot.status}` : `c:${normalizeLaneName(slot.col.name)}`;

	const merged: BoardColumnSlot[] = [];
	const indexOfKey = (key: string) => merged.findIndex((existing) => keyOf(existing) === key);

	for (const project of projects) {
		const slots = projectBoardColumns(project, opts);
		// Anchor = where the previous lane of THIS project landed. An unseen lane
		// goes after it, but never before a lane an earlier project already placed
		// there — so the first project's order wins ties.
		let anchor = -1;
		for (let i = 0; i < slots.length; i++) {
			const slot = slots[i];
			const at = indexOfKey(keyOf(slot));
			if (at !== -1) {
				const existing = merged[at];
				if (existing.type === "custom" && slot.type === "custom") existing.members.push(...slot.members);
				anchor = at;
				continue;
			}
			// The next lane of this project that is already on the board is the
			// latest point the new lane may take without jumping over it.
			let limit = merged.length;
			for (let j = i + 1; j < slots.length; j++) {
				const next = indexOfKey(keyOf(slots[j]));
				if (next !== -1) {
					limit = next;
					break;
				}
			}
			anchor = Math.max(anchor + 1, limit);
			merged.splice(anchor, 0, slot);
		}
	}
	return merged;
}
