import { ALL_STATUSES, type Task, type TaskStatus } from "../../shared/types";

/**
 * Column a task falls back to when its own `status` matches no built-in column
 * (a hand-edited tasks.json, or a status written by a newer app version).
 */
export const UNKNOWN_STATUS_FALLBACK: TaskStatus = "todo";

/**
 * Buckets board tasks into their built-in status columns.
 *
 * Every task that is not in a custom column ends up in exactly one bucket: an
 * unrecognized status lands in To Do instead of being dropped. A dropped card is
 * invisible on the board yet still present in tasks.json and to the CLI, and it
 * survives a restart — indistinguishable from data loss for the user.
 */
export function partitionTasksByStatus(
	tasks: Task[],
	isInCustomColumn: (task: Task) => boolean,
): Map<TaskStatus, Task[]> {
	const byStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) byStatus.set(status, []);
	const fallback = byStatus.get(UNKNOWN_STATUS_FALLBACK)!;
	for (const task of tasks) {
		if (isInCustomColumn(task)) continue;
		(byStatus.get(task.status) ?? fallback).push(task);
	}
	return byStatus;
}
