import { ACTIVE_STATUSES } from "./task-status";
import { priorityRank } from "./task-priority";
import type { Task } from "./task";

// ---- Task type ----

/** Named agent roles; only coordinators receive a sort lift. */
export const TASK_TYPES = ["coordinator", "pr-review", "board-cleanup"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Narrows free-form input (CLI, older data file) to a known task type. */
export function normalizeTaskType(input: string): TaskType | null {
	const value = input.trim().toLowerCase();
	return (TASK_TYPES as readonly string[]).includes(value) ? (value as TaskType) : null;
}

export function isCoordinatorTask(task: { taskType?: TaskType | null }): boolean {
	return task.taskType === "coordinator";
}

/** Derived so no writer can accidentally enable merge completion for an audit or coordinator. */
export function taskCompletesManually(
	task: { manualCompletion?: boolean; taskType?: TaskType | null },
): boolean {
	return task.manualCompletion === true || isCoordinatorTask(task) || task.taskType === "board-cleanup";
}

/**
 * Rank offset added to a hibernated task so it sinks below every live P4 while
 * hibernated tasks stay internally ordered by their own priority. Any value
 * above the highest priority rank works; 10 keeps the two bands readable in a
 * debugger.
 */
export const HIBERNATED_SORT_OFFSET = 10;

/**
 * Rank offset added to a disconnected task. Sits between the live band and the
 * hibernated one: a dead session is not running, but unlike hibernation nobody
 * chose it, so it stays the first thing under the live work.
 */
export const DISCONNECTED_SORT_OFFSET = 5;

/**
 * Rank offset lifting a live coordinator above every live priority band: it is
 * the task the user talks to in order to reach all the others, so it must never
 * be scrolled to. Negative and wider than the P0–P4 spread, so the coordinator
 * band (−10…−6) cannot collide with the live band (0…4).
 *
 * Deliberately applied ONLY while the coordinator is live — a hibernated or
 * disconnected coordinator sinks like any other task, because a lift would
 * advertise an agent that is not there.
 */
export const COORDINATOR_SORT_OFFSET = -10;

/**
 * The subset of a task the shared sort comparator reads. Every field is
 * optional: a caller ranking a stub (a test, a CLI row) only has to supply what
 * it actually knows, and a missing field simply keeps the task in the live band.
 */
export type TaskSortFields = Partial<
	Pick<
		Task,
		| "priority"
		| "hibernated"
		| "status"
		| "worktreePath"
		| "runtimeState"
		| "draft"
		| "preparing"
		| "shuttingDown"
		| "taskType"
	>
>;

/**
 * Is this task's agent session gone? True for a task still parked in an active
 * column with its worktree intact, whose runtime the boot probe found dead —
 * the app was force-quit or the machine restarted, and tmux/the native host did
 * not survive it. Derived, never stored: attaching a terminal writes the runtime
 * hint back to `running` and the task rejoins the live band.
 */
export function isTaskDisconnected(task: TaskSortFields): boolean {
	if (task.hibernated || task.draft || task.preparing || task.shuttingDown) return false;
	if (!task.worktreePath) return false;
	if (!task.status || !ACTIVE_STATUSES.includes(task.status)) return false;
	return task.runtimeState?.runtime === "idle";
}

/**
 * Does this task look like it has an agent session running right now? Derived
 * from persisted state only — nothing is probed — so it may only decide whether
 * to TELL the user something, never whether a delivery happened. A launch that
 * has not happened yet (`todo`, draft, preparing) reads false on purpose: such a
 * task still gets its description as the agent's first prompt.
 */
export function taskAgentSessionLooksLive(task: TaskSortFields): boolean {
	if (task.hibernated || task.draft || task.preparing || task.shuttingDown) return false;
	if (!task.worktreePath) return false;
	if (!task.status || !ACTIVE_STATUSES.includes(task.status)) return false;
	return !isTaskDisconnected(task);
}

/**
 * Sort rank of a task: its {@link priorityRank}, plus {@link HIBERNATED_SORT_OFFSET}
 * when hibernated, {@link DISCONNECTED_SORT_OFFSET} when its session died, or
 * {@link COORDINATOR_SORT_OFFSET} when it is a live coordinator. None of the
 * three writes `priority`, so a woken, resumed or demoted task returns to its
 * rightful place in the queue.
 *
 * The sink bands are tested first on purpose: a parked coordinator is not the
 * thing to look at, so it loses the lift for as long as it is parked.
 */
export function taskSortRank(task: TaskSortFields): number {
	const rank = priorityRank(task.priority);
	if (task.hibernated) return rank + HIBERNATED_SORT_OFFSET;
	if (isTaskDisconnected(task)) return rank + DISCONNECTED_SORT_OFFSET;
	if (isCoordinatorTask(task)) return rank + COORDINATOR_SORT_OFFSET;
	return rank;
}

/**
 * The one comparator every task list sorts by: strict priority bands, then a
 * disconnected band, then a hibernated sink band. Deliberately splits a variant
 * group when one variant is parked — the board should show honestly how many
 * attempts are still alive.
 */
export function compareTaskSortRank(a: TaskSortFields, b: TaskSortFields): number {
	return taskSortRank(a) - taskSortRank(b);
}
