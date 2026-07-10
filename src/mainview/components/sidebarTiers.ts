import { comparePriority, type Task } from "../../shared/types";
import { isAttentionTask } from "../utils/taskFacets";

/**
 * Readiness tiers for the Active Tasks sidebar. The sidebar is a live work
 * queue, so it groups by "how much this needs YOU right now" instead of by raw
 * status. Three tiers, rendered top → bottom:
 *
 *   - `needs-you`  — waiting on the user: `review-by-user` ∪ `user-questions` ∪
 *                    `review-by-colleague` that currently has a live signal.
 *   - `custom`     — one tier per project custom column (deliberate manual
 *                    placement), in the project's column order, between the two
 *                    built-in tiers.
 *   - `waiting`    — nothing needs the user: `in-progress` ∪ `review-by-ai` ∪
 *                    `review-by-colleague` without a signal.
 *
 * "Signal" = a positive per-task bell count on a `review-by-colleague` task (the
 * background PR poller raises it on a CI/review event). It is the one status
 * whose tier depends on runtime signal, not status alone. Per-task attention
 * bells (`dev3 attention`) are purely visual and never move a task between tiers.
 *
 * See UX_DECISIONS 2026-07-11 and decision record 124.
 */
export type SidebarTierKind = "needs-you" | "custom" | "waiting";

export interface SidebarTier {
	kind: SidebarTierKind;
	/** Stable React key. */
	key: string;
	/** Present only for `custom` tiers: the owning project + column, so the
	 *  component can resolve the column's name and color for its header. */
	projectId?: string;
	customColumnId?: string;
	/** Tasks in final render order (priority band → oldest `movedAt` → `seq`). */
	tasks: Task[];
}

/** A custom column in render order (project column order). */
export interface OrderedCustomColumn {
	projectId: string;
	columnId: string;
}

export interface TierGroupingContext {
	scope: "project" | "global" | "attention";
	/** Per-task live bell count; a positive value is the `review-by-colleague`
	 *  "signal" that promotes a PR into the `needs-you` tier. */
	bellCounts: Map<string, number>;
	/** Custom columns in the order their tiers should render. For project scope
	 *  this is the current project's columns; for global scope, every project's
	 *  columns concatenated. Ignored in attention scope. */
	orderedCustomColumns: OrderedCustomColumn[];
}

/**
 * Within-tier order: strict priority bands first (P0 on top), then oldest-first
 * by `movedAt` (the longest-waiting task in a band is most at risk of being
 * forgotten), then `seq` as a stable tiebreak. Tasks without `movedAt` sink to
 * the bottom of their band. A whole variant group shares one priority, so a band
 * never splits a group.
 */
export function byPriorityThenMovedAtOldestFirst(a: Task, b: Task): number {
	const byPriority = comparePriority(a.priority, b.priority);
	if (byPriority !== 0) return byPriority;
	const aTime = a.movedAt ? new Date(a.movedAt).getTime() : Infinity;
	const bTime = b.movedAt ? new Date(b.movedAt).getTime() : Infinity;
	if (aTime !== bTime) return aTime - bTime;
	return a.seq - b.seq;
}

/**
 * Group the sidebar's active tasks into ordered readiness tiers, each with its
 * tasks in final render order. Pure — no i18n, colors, or DOM — so the ordering
 * rules are unit-testable without rendering the component. The component maps the
 * returned structure to headers/labels/colors.
 *
 * Empty tiers are omitted. In `attention` scope the result is the `needs-you`
 * tier at global breadth only — a single flat tier of every task that needs the
 * user (same membership as the attention bell), priority-sorted; custom and
 * `waiting` tiers are never produced.
 */
export function groupTasksIntoTiers(tasks: Task[], ctx: TierGroupingContext): SidebarTier[] {
	const { scope, bellCounts, orderedCustomColumns } = ctx;

	if (scope === "attention") {
		const filtered = tasks.filter((task) => isAttentionTask(task, bellCounts));
		if (filtered.length === 0) return [];
		return [
			{ kind: "needs-you", key: "attention", tasks: filtered.slice().sort(byPriorityThenMovedAtOldestFirst) },
		];
	}

	const needsYou: Task[] = [];
	const waiting: Task[] = [];
	const customByKey = new Map<string, Task[]>();

	for (const task of tasks) {
		if (task.customColumnId) {
			const key = `${task.projectId}|${task.customColumnId}`;
			const existing = customByKey.get(key);
			if (existing) existing.push(task);
			else customByKey.set(key, [task]);
			continue;
		}
		// A non-custom task is "needs you" on exactly the same rule as the
		// attention bell/`is:attention` facet — reuse that single source of truth
		// (an attention status, or a signalled `review-by-colleague`) so the
		// sidebar's tier split and the attention scope can never disagree.
		if (isAttentionTask(task, bellCounts)) needsYou.push(task);
		else waiting.push(task);
	}

	const tiers: SidebarTier[] = [];
	if (needsYou.length > 0) {
		tiers.push({ kind: "needs-you", key: "needs-you", tasks: needsYou.sort(byPriorityThenMovedAtOldestFirst) });
	}
	for (const { projectId, columnId } of orderedCustomColumns) {
		const key = `${projectId}|${columnId}`;
		const colTasks = customByKey.get(key);
		if (colTasks && colTasks.length > 0) {
			tiers.push({
				kind: "custom",
				key: `custom:${key}`,
				projectId,
				customColumnId: columnId,
				tasks: colTasks.sort(byPriorityThenMovedAtOldestFirst),
			});
		}
	}
	if (waiting.length > 0) {
		tiers.push({ kind: "waiting", key: "waiting", tasks: waiting.sort(byPriorityThenMovedAtOldestFirst) });
	}
	return tiers;
}
