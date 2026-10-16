import type { TaskStatus } from "./task-status";

export type NoteSource = "user" | "ai";

export interface TaskNote {
	id: string;
	content: string;
	source: NoteSource;
	createdAt: string;
	updatedAt: string;
}

/**
 * Per-task note retention (oldest dropped first). A bug-hunting task can pile up
 * hundreds of agent notes — 251 on one dev-3.0 task — and every one of them is
 * re-serialized on every save of the whole board.
 */
export const MAX_TASK_NOTES_KEPT = 50;

/**
 * Append `note` to a task's note list, evicting the oldest entries past
 * {@link MAX_TASK_NOTES_KEPT}. Applied at every insert site so the cap is an
 * invariant of writing rather than of one caller.
 */
export function appendTaskNote(existing: TaskNote[] | undefined, note: TaskNote): TaskNote[] {
	return [...(existing ?? []), note].slice(-MAX_TASK_NOTES_KEPT);
}

/**
 * What kind of board movement happened. `created` is the card appearing at all,
 * `status` a builtin-column change (completion and cancellation are just
 * `to: "completed"` / `to: "cancelled"`), `column` a move between a builtin and a
 * custom column that share one status.
 */
export type TaskMovementKind = "created" | "status" | "column";

/**
 * One immutable record of a task changing its position on the board. Written at
 * the single choke point every move already passes through (`applyTaskUpdate` in
 * `src/bun/data.ts`), because past moves are otherwise unrecoverable: a task
 * keeps only `statusEnteredAt` for its CURRENT status, and `statusDurations` says
 * a status was visited without saying when or in what order.
 */
export interface TaskMovement {
	/** UUID — the addressable id `dev3 events --from <prefix>` resolves. */
	id: string;
	at: string;
	kind: TaskMovementKind;
	/** Status left behind. Absent on `created`. */
	from?: TaskStatus;
	to: TaskStatus;
	/** Custom column id left behind, when the card was in one. */
	fromColumnId?: string | null;
	/** Custom column id landed in, when the card ended in one. */
	toColumnId?: string | null;
}

/**
 * Per-task movement retention (oldest dropped first). A task that ping-pongs
 * through review can accumulate dozens, and every one is re-serialized on every
 * save of the whole board — the same pressure that caps notes.
 */
export const MAX_TASK_MOVEMENTS_KEPT = 50;

/**
 * Append a movement, evicting the oldest past {@link MAX_TASK_MOVEMENTS_KEPT}.
 * Returns the eviction count too, so the caller can keep a running total and a
 * reader is told its answer is incomplete rather than shown a trimmed log.
 */
export function appendTaskMovement(
	existing: TaskMovement[] | undefined,
	movement: TaskMovement,
): { movements: TaskMovement[]; dropped: number } {
	const all = [...(existing ?? []), movement];
	return {
		movements: all.slice(-MAX_TASK_MOVEMENTS_KEPT),
		dropped: Math.max(0, all.length - MAX_TASK_MOVEMENTS_KEPT),
	};
}
