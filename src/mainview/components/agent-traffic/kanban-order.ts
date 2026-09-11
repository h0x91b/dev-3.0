/**
 * Where a traffic card sits relative to the coordinator: its own board column.
 *
 * The order is the board's, not a second lifecycle invented here — `getBoardColumns`
 * already merges every visible project's columns into one display order (custom
 * columns included, hidden ones dropped), so a user who reorders their Kanban
 * reorders the stage with it. Rank 0 is the column nearest the coordinator, so
 * Completed and Cancelled land at the far end simply because that is where the
 * board puts them.
 *
 * The status is read from the replay projection, never from `task.status` — at a
 * cursor an hour back the live status is not what the card was.
 */

import { getBoardColumns, laneKey, type BoardProject, type TaskStatus } from "../../../shared/types";
import type { TaskProjection } from "./task-history";
import type { TrafficNode } from "./traffic-model";

export interface KanbanOrder {
	/** Lower sits closer to the coordinator. Cards with no known column sort last. */
	rank(node: TrafficNode): number;
	/** A To Do card at the cursor — board backlog, not conversation. */
	todo(node: TrafficNode): boolean;
}

/**
 * A card whose column cannot be resolved — the user marker, a ghost the message
 * log remembers but the board no longer holds, a task whose past was never
 * recorded — sorts after every column rather than being guessed into one: it has
 * no position on the board, and the live status is not evidence about the cursor.
 */
export function kanbanOrder(
	projects: BoardProject[],
	nodes: TrafficNode[],
	projection: (node: TrafficNode) => TaskProjection,
): KanbanOrder {
	// A column holding cards is never hidden, same rule the board itself applies.
	const occupiedStatuses = new Set<TaskStatus>();
	for (const node of nodes) {
		const status = projection(node).status;
		if (status) occupiedStatuses.add(status);
	}
	const columns = getBoardColumns(projects, { occupiedStatuses });
	const rankByLane = new Map<string, number>();
	const laneByCustom = new Map<string, string>();
	columns.forEach((slot, index) => {
		rankByLane.set(laneKey(slot), index);
		if (slot.type === "custom")
			for (const member of slot.members)
				laneByCustom.set(`${member.projectId}::${member.columnId}`, laneKey(slot));
	});
	const unplaceable = columns.length;
	const lanes = new Map<string, string | null>();
	const laneOf = (node: TrafficNode): string | null => {
		const cached = lanes.get(node.key);
		if (cached !== undefined) return cached;
		const { status, columnId } = projection(node);
		// A dangling custom column id (its column was deleted) falls back to the
		// underlying status, exactly as the board does.
		const lane = (columnId ? laneByCustom.get(`${node.projectId}::${columnId}`) : undefined) ?? status ?? null;
		lanes.set(node.key, lane);
		return lane;
	};
	return {
		rank: (node) => {
			const lane = laneOf(node);
			return (lane === null ? undefined : rankByLane.get(lane)) ?? unplaceable;
		},
		todo: (node) => laneOf(node) === "todo",
	};
}
