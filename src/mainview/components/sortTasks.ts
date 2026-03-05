import type { Task } from "../../shared/types";

export function sortTasksForColumn(
	tasks: Task[],
	dropPosition: "top" | "bottom",
	moveOrderMap: Map<string, number>,
): Task[] {
	return [...tasks].sort((a, b) => {
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
