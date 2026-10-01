import type { Task } from "../../shared/types";
import { ACTIVE_STATUSES, isCoordinatorTask, isTaskDisconnected } from "../../shared/types";

/** What the user would find if they opened this coordinator right now. */
export type CoordinatorState = "current" | "live" | "disconnected" | "hibernated";

export interface CoordinatorCandidate {
	task: Task;
	state: CoordinatorState;
}

const STATE_BAND: Record<CoordinatorState, number> = { current: 0, live: 0, disconnected: 1, hibernated: 2 };

function coordinatorState(task: Task, currentTaskId: string | null): CoordinatorState {
	if (task.id === currentTaskId) return "current";
	if (task.hibernated) return "hibernated";
	if (isTaskDisconnected(task)) return "disconnected";
	return "live";
}

/**
 * Every active coordinator across the given tasks, decided by `taskType` alone —
 * a task merely titled "coordinator" is not one. Deliberately ignores the Active
 * Tasks visibility (`hidden`, hibernated filtering): this is a finder, and a
 * coordinator the user hid from the sidebar must still be findable here.
 *
 * Order: live (current included) → no session → hibernated; MRU inside a band,
 * then newest seq.
 */
export function coordinatorCandidates(tasks: Task[], currentTaskId: string | null, mru: string[]): CoordinatorCandidate[] {
	const recency = new Map(mru.map((id, i) => [id, i]));
	return tasks
		.filter((task) => isCoordinatorTask(task) && ACTIVE_STATUSES.includes(task.status))
		.map((task) => ({ task, state: coordinatorState(task, currentTaskId) }))
		.sort((a, b) => {
			const band = STATE_BAND[a.state] - STATE_BAND[b.state];
			if (band !== 0) return band;
			const ra = recency.get(a.task.id) ?? Number.POSITIVE_INFINITY;
			const rb = recency.get(b.task.id) ?? Number.POSITIVE_INFINITY;
			if (ra !== rb) return ra - rb;
			return b.task.seq - a.task.seq;
		});
}
