import { compareTaskSortRank, type GlobalSettings, type Task, type TaskStatus } from "../../shared/types";

export type TaskSortOrder = GlobalSettings["taskSortOrder"];

/**
 * Terminal columns are a chronological log, not a prioritized queue: the user
 * wants the most recently finished/cancelled task on top, ignoring priority and
 * the sort-order setting.
 */
const RECENCY_SORTED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "cancelled"]);

// "When this task last changed status" — the activity clock every live column
// sorts by. `statusEnteredAt` is absent on tasks that predate status-time
// tracking, so fall back through the column-entry stamp to creation rather than
// letting them all collapse into one indistinguishable "forever ago" block.
export function taskActivityTime(task: Task): number {
	const parsed = Date.parse(task.statusEnteredAt ?? task.movedAt ?? task.createdAt);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The one in-band comparator, shared by the Kanban board and the Active Tasks
 * sidebar so the two surfaces can never disagree: strict priority bands first
 * (every P0 above every P1, hibernated tasks in a sink band below every live
 * P4), then the activity clock in the direction the user picked, then `seq` as a
 * stable tiebreak. Variants are ordered like any other task — a group is not
 * held together, since every task stands on its own until epics land.
 */
export function compareTasksInBand(a: Task, b: Task, order: TaskSortOrder): number {
	const byPriority = compareTaskSortRank(a, b);
	if (byPriority !== 0) return byPriority;
	const aTime = taskActivityTime(a);
	const bTime = taskActivityTime(b);
	if (aTime !== bTime) return order === "oldest-first" ? aTime - bTime : bTime - aTime;
	return a.seq - b.seq;
}

export function sortTasksForColumn(tasks: Task[], order: TaskSortOrder, status?: TaskStatus): Task[] {
	if (status !== undefined && RECENCY_SORTED_STATUSES.has(status)) {
		return [...tasks].sort((a, b) => {
			const aTime = Date.parse(a.movedAt ?? a.createdAt);
			const bTime = Date.parse(b.movedAt ?? b.createdAt);
			if (aTime !== bTime) return bTime - aTime;
			return a.seq - b.seq;
		});
	}
	return [...tasks].sort((a, b) => compareTasksInBand(a, b, order));
}
