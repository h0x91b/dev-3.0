import { comparePriority, type Task, type TaskStatus } from "../../shared/types";

/**
 * Terminal columns are a chronological log, not a prioritized queue: the user
 * wants the most recently finished/cancelled task on top, ignoring priority.
 */
const RECENCY_SORTED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "cancelled"]);

// "When it landed in this column" — `movedAt` is stamped on every rendered-column
// change; fall back to `createdAt` for tasks that predate movedAt tracking.
function columnEntryTime(task: Task): string {
	return task.movedAt ?? task.createdAt;
}

export function sortTasksForColumn(
	tasks: Task[],
	dropPosition: "top" | "bottom",
	moveOrderMap: Map<string, number>,
	status?: TaskStatus,
): Task[] {
	// Completed / Cancelled: pure recency, freshest on top, regardless of priority,
	// variant grouping, persisted column order, or the global drop-position setting.
	if (status !== undefined && RECENCY_SORTED_STATUSES.has(status)) {
		return [...tasks].sort((a, b) => {
			// In-session cross-column moves win so a just-finished card jumps to the
			// top instantly, before the backend `movedAt` refresh round-trips.
			const aOrder = moveOrderMap.get(a.id) ?? 0;
			const bOrder = moveOrderMap.get(b.id) ?? 0;
			if (aOrder !== bOrder) return bOrder - aOrder;
			// Then persisted entry time, most recent first.
			const aTime = columnEntryTime(a);
			const bTime = columnEntryTime(b);
			if (aTime !== bTime) return aTime > bTime ? -1 : 1;
			// Stable, deterministic tiebreak.
			return a.id < b.id ? -1 : 1;
		});
	}
	return [...tasks].sort((a, b) => {
		// Strict priority bands are the TOPMOST key: every P0 above every P1, etc.
		// A whole variant group shares one priority, so banding never splits a group.
		// All existing rules below apply UNCHANGED within a single band.
		const byPriority = comparePriority(a.priority, b.priority);
		if (byPriority !== 0) return byPriority;
		// Move order takes top priority (in-session cross-column moves)
		const aOrder = moveOrderMap.get(a.id) ?? 0;
		const bOrder = moveOrderMap.get(b.id) ?? 0;
		if (aOrder !== bOrder) {
			// "top": highest counter first (most recent at top)
			// "bottom": lowest counter first (most recent at bottom)
			return dropPosition === "top" ? bOrder - aOrder : aOrder - bOrder;
		}
		// Persisted column order (set by within-column reordering)
		const aCol = a.columnOrder;
		const bCol = b.columnOrder;
		if (aCol !== undefined && bCol !== undefined) {
			return aCol - bCol;
		}
		// Tasks with explicit columnOrder come before those without
		if (aCol !== undefined) return -1;
		if (bCol !== undefined) return 1;
		// Group by groupId: tasks with same groupId stay together
		const aGroup = a.groupId ?? "";
		const bGroup = b.groupId ?? "";
		if (aGroup !== bGroup) {
			if (!aGroup) return 1;
			if (!bGroup) return -1;
			return aGroup < bGroup ? -1 : 1;
		}
		// Within same group, sort by variantIndex
		if (a.groupId && b.groupId) {
			return (a.variantIndex ?? 0) - (b.variantIndex ?? 0);
		}
		// Ungrouped: sort by position preference using movedAt (persisted across reloads)
		if (dropPosition === "top") {
			if (a.movedAt && b.movedAt) return b.movedAt > a.movedAt ? 1 : -1;
			if (a.movedAt) return -1;
			if (b.movedAt) return 1;
		} else {
			// "bottom": recently moved tasks go to the end
			if (a.movedAt && b.movedAt) return a.movedAt > b.movedAt ? 1 : -1;
			if (a.movedAt) return 1;
			if (b.movedAt) return -1;
		}
		return a.createdAt < b.createdAt ? -1 : 1;
	});
}
