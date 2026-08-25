/**
 * Collect the `<dev3-board>` snapshot a coordinator receives on every turn.
 *
 * The contract and the rendering live in `shared/coordinator-board`; this module
 * only gathers the facts. The design constraint that shapes it: this runs on
 * EVERY message delivered to a coordinator task, so it must be cheap and it must
 * never throw — a snapshot that fails is a missing block, never a blocked agent.
 *
 * Everything here therefore comes out of `tasks.json`, which the caller has
 * already loaded. It deliberately does NOT ask tmux how quiet a task's terminal
 * is: that number is unusable on a real board, and asking cost a `list-panes`
 * per socket for the privilege of printing noise.
 */

import type { Project, Task } from "../shared/types";
import {
	compareTaskSortRank,
	getTaskTitle,
	isCoordinatorTask,
	STATUS_LABELS,
	type TaskStatus,
} from "../shared/types";
import {
	BOARD_FINISHED_WINDOW_MS,
	BOARD_MAX_ROWS,
	renderCoordinatorBoard,
	type BoardRow,
	type BoardSnapshot,
} from "../shared/coordinator-board";
import * as data from "./data";
import { createLogger } from "./logger";

const log = createLogger("coordinator-board");

/** A task the coordinator is managing right now: not parked in To Do, not finished. */
function isLive(status: TaskStatus): boolean {
	return status !== "todo" && status !== "completed" && status !== "cancelled";
}

function isFinished(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

/** When the task reached its terminal column. `movedAt` is that move; `updatedAt` is the floor. */
function finishedAt(task: Task): string {
	return task.movedAt ?? task.updatedAt;
}

/** Built-in column label, or the custom column's own name when the task sits in one. */
function columnOf(task: Task, project: Project): string {
	if (task.customColumnId) {
		const custom = project.customColumns?.find((c) => c.id === task.customColumnId);
		if (custom) return custom.name;
	}
	return STATUS_LABELS[task.status as TaskStatus] ?? task.status;
}

/**
 * When the task entered the column it is in now. `statusEnteredAt` is the
 * precise answer; `movedAt` covers tasks that predate it and also carries
 * custom-column moves, and `createdAt` is the floor for the oldest tasks. Same
 * fallback chain as `accumulateStatusDuration` and `dev3 doctor-worktrees`.
 */
function columnSince(task: Task): string | null {
	return task.statusEnteredAt ?? task.movedAt ?? task.createdAt ?? null;
}

function toRow(task: Task, project: Project, sharedSeqs: Set<number>): BoardRow {
	return {
		taskId: task.id,
		seq: task.seq,
		variantIndex: task.variantIndex ?? null,
		seqShared: sharedSeqs.has(task.seq),
		title: getTaskTitle(task),
		column: columnOf(task, project),
		hibernated: task.hibernated === true,
		draft: task.draft === true,
		columnSince: columnSince(task),
		finishedAt: isFinished(task.status as TaskStatus) ? finishedAt(task) : null,
	};
}

/**
 * Which seqs more than one LIVE task still answers to. Only those need the id in
 * parentheses: a variant group usually loses every member but one, and the
 * survivor keeps `variantIndex` forever while its seq is perfectly unambiguous
 * (the same reasoning as `agentReplyRef`). Finished siblings do not count — the
 * CLI resolves against the live board.
 */
function sharedSeqsOf(live: Task[]): Set<number> {
	const seen = new Map<number, number>();
	for (const task of live) seen.set(task.seq, (seen.get(task.seq) ?? 0) + 1);
	return new Set([...seen].filter(([, count]) => count > 1).map(([seq]) => seq));
}

/**
 * The board snapshot to append to a message being delivered to `task`, or "" if
 * it is not a coordinator. Never throws and never blocks a delivery: a message
 * that arrives without its trailer is worth incomparably more than one that does
 * not arrive.
 */
export async function coordinatorBoardEpilogue(task: Task): Promise<string> {
	if (!isCoordinatorTask(task)) return "";
	try {
		const project = await data.getProject(task.projectId);
		const tasks = await data.loadTasks(project);
		const now = new Date();
		return renderCoordinatorBoard(collectCoordinatorBoard(project, tasks, now), now);
	} catch (err) {
		log.warn("could not build the coordinator board trailer", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
		return "";
	}
}

/**
 * Build the snapshot for a coordinator's own board. Never throws: the caller is
 * standing between an agent and a message it is owed.
 */
export function collectCoordinatorBoard(project: Project, tasks: Task[], now: Date): BoardSnapshot {
	const nowMs = now.getTime();

	const live = tasks
		.filter((t) => isLive(t.status as TaskStatus))
		.sort((a, b) => compareTaskSortRank(a, b) || a.seq - b.seq);
	const finished = tasks
		.filter((t) => isFinished(t.status as TaskStatus))
		.filter((t) => nowMs - Date.parse(finishedAt(t)) <= BOARD_FINISHED_WINDOW_MS)
		.sort((a, b) => Date.parse(finishedAt(b)) - Date.parse(finishedAt(a)));

	const sharedSeqs = sharedSeqsOf(live);
	const row = (task: Task) => toRow(task, project, sharedSeqs);

	// Live rows are what the coordinator manages, so the cap eats the finished
	// tail first and reports honestly how much it dropped.
	const liveRows = live.slice(0, BOARD_MAX_ROWS).map(row);
	const finishedBudget = Math.max(0, BOARD_MAX_ROWS - liveRows.length);
	const finishedRows = finished.slice(0, finishedBudget).map(row);
	const omitted = (live.length - liveRows.length) + (finished.length - finishedRows.length);

	return {
		at: now.toISOString(),
		projectName: project.name,
		live: liveRows,
		finished: finishedRows,
		omitted,
	};
}
