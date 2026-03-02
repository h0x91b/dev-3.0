import type { Task } from "../../shared/types";

export function sortTasksForColumn(
	tasks: Task[],
	dropPosition: "top" | "bottom",
	moveOrderMap: Map<string, number>,
): Task[] {
	return [...tasks].sort((a, b) => {
		// Move order takes top priority (both modes)
		const aOrder = moveOrderMap.get(a.id) ?? 0;
		const bOrder = moveOrderMap.get(b.id) ?? 0;
		if (aOrder !== bOrder) {
			// "top": highest counter first (most recent at top)
			// "bottom": lowest counter first (most recent at bottom)
			return dropPosition === "top" ? bOrder - aOrder : aOrder - bOrder;
		}
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
		// lastActivityAt: terminal requested attention (bell) or process exited
		const aActivity = a.lastActivityAt ?? "";
		const bActivity = b.lastActivityAt ?? "";
		if (aActivity !== bActivity) {
			if (dropPosition === "top") return bActivity > aActivity ? 1 : -1;
			else return aActivity > bActivity ? 1 : -1;
		}
		// Ungrouped: sort by movedAt (persisted across reloads)
		if (a.movedAt && b.movedAt && a.movedAt !== b.movedAt) {
			if (dropPosition === "top") return b.movedAt > a.movedAt ? 1 : -1;
			else return a.movedAt > b.movedAt ? 1 : -1;
		}
		if (a.movedAt) return dropPosition === "top" ? -1 : 1;
		if (b.movedAt) return dropPosition === "top" ? 1 : -1;
		return a.createdAt < b.createdAt ? -1 : 1;
	});
}
