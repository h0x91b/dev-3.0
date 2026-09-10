/**
 * Where replay is standing in time, and what a task looked like at that instant.
 *
 * Replay used to draw every card in its state RIGHT NOW: a task completed an hour
 * after the message being replayed was already green, and a task created after it
 * was already on stage. This module answers the only question that fixes that —
 * "what did this task look like at time T?" — and answers it strictly from what
 * dev3 actually wrote down.
 *
 * The source is `Task.movements[]` (`src/shared/types.ts`), the board-movement log
 * PR #1661 started capturing on 2026-09-06. Nothing older can be reconstructed:
 * `statusEnteredAt` dates only the LAST move, `statusDurations` proves a status was
 * visited without saying when, and `Task.history[]` carries title/overview only. So
 * a task with no movements has no past here, and this module says `unrecorded`
 * rather than passing the current status off as history.
 *
 * Truncation is real from day one — `MAX_TASK_MOVEMENTS_KEPT` is 50 and tasks
 * already hit it — so a missing `created` entry does NOT mean "pre-feature task".
 * That is why there are three confidence values and not two.
 */

import type { Task, TaskMovement, TaskStatus } from "../../../shared/types";
import type { TrafficTimelineEventKind } from "./traffic-timeline";

/** Where replay is standing in time. `at === null` means live — no cursor at all. */
export interface ReplayCursor {
	/**
	 * Epoch ms of the event being shown, or null when live. This is the value to
	 * select by — never the index: an index into messages cannot express an
	 * interval where the board moved and nobody said anything.
	 */
	at: number | null;
	/** Index into the playback event list; -1 when live. */
	index: number;
	total: number;
	playing: boolean;
	/** Which kind of event the cursor is standing on; null when live. */
	kind: TrafficTimelineEventKind | null;
}

/**
 * How much of a task's past we can prove at a given cursor.
 *
 * - `recorded` — movements cover the task from its own `created` entry and nothing
 *   was evicted. Both the status and the moment it appeared are facts.
 * - `partial` — movements exist but the birth is gone (evicted by the cap, or
 *   capture started mid-life). The status is still a fact; the birth is not, so the
 *   card is treated as already present.
 * - `unrecorded` — no movements at all. Nothing about the past is known, so the
 *   status is `null`; the live status is NOT substituted.
 */
export type TaskHistoryConfidence = "recorded" | "partial" | "unrecorded";

export interface TaskProjection {
	/** False only when we KNOW the card did not exist yet. Never false on a guess. */
	present: boolean;
	/**
	 * Status at the cursor, or `null` for NOT KNOWN.
	 *
	 * `null` is never a stand-in for the live status. Showing the current status with
	 * a disclaimer beside it was the original shape and was ruled out: a green
	 * "Completed" card reads as history whatever the small print says. A caller must
	 * render `null` neutrally and must never substitute `task.status`.
	 */
	status: TaskStatus | null;
	/** Custom column at the cursor, or null. */
	columnId: string | null;
	confidence: TaskHistoryConfidence;
}

function sorted(movements: TaskMovement[]): TaskMovement[] {
	return [...movements].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Project one task onto the cursor.
 *
 * Pure and total: the same task and the same cursor always give the same answer,
 * which is what makes scrubbing backwards reverse the stage exactly. There is no
 * accumulated state to unwind, so a seek is not a rewind — it is a recomputation.
 *
 * A task the caller has no `Task` for at all (a ghost the message log remembers but
 * the board no longer holds) is `unrecorded` and present: it demonstrably existed
 * when the message flew, and its status is genuinely unknown.
 */
export function projectTaskAt(
	task: Task | undefined,
	at: number | null,
): TaskProjection {
	const unknown: TaskProjection = {
		present: true,
		status: null,
		columnId: null,
		confidence: "unrecorded",
	};
	if (!task) return unknown;
	if (at === null) {
		return {
			present: true,
			status: task.status,
			columnId: task.customColumnId ?? null,
			confidence: "recorded",
		};
	}
	const movements = task.movements?.length ? sorted(task.movements) : null;
	if (!movements) return unknown;

	const complete =
		movements[0].kind === "created" && !(task.movementsDropped ?? 0);
	const confidence: TaskHistoryConfidence = complete ? "recorded" : "partial";
	let last: TaskMovement | undefined;
	for (const movement of movements) {
		if (Date.parse(movement.at) > at) break;
		last = movement;
	}
	if (last) {
		return {
			present: true,
			status: last.to,
			columnId: last.toColumnId ?? null,
			confidence,
		};
	}
	// Cursor sits before every recorded movement. A `created` first entry proves
	// the card did not exist yet; anything else hands us the state it was leaving,
	// which is a recorded fact about the past even though the birth is not.
	const first = movements[0];
	if (first.kind === "created") {
		return {
			present: false,
			status: first.to,
			columnId: first.toColumnId ?? null,
			confidence,
		};
	}
	return {
		present: true,
		// `from` is recorded evidence about the past, so it is used. Its absence is
		// not an excuse to reach for the live status — that stays unknown.
		status: first.from ?? null,
		columnId: first.fromColumnId ?? null,
		confidence: "partial",
	};
}
