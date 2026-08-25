/**
 * Collect the `<dev3-board>` snapshot a coordinator receives on every turn.
 *
 * The contract and the rendering live in `shared/coordinator-board`; this module
 * only gathers the facts. The design constraint that shapes it: this runs inside
 * a hook on EVERY turn of a coordinator task, so it must be cheap and it must
 * never throw — a snapshot that fails is a missing block, never a blocked agent.
 *
 * Activity times therefore cost exactly one `tmux list-panes -a` per distinct
 * socket (normally one for the whole machine), not one peek per task. Native
 * panes have no cheap per-pane time at all — peek only learns one by capturing
 * — so they report `unknown` rather than borrowing a clock.
 */

import type { Project, Task } from "../shared/types";
import {
	compareTaskSortRank,
	getTaskTitle,
	isCoordinatorTask,
	isTaskDisconnected,
	STATUS_LABELS,
	type TaskStatus,
} from "../shared/types";
import {
	BOARD_FINISHED_WINDOW_MS,
	BOARD_MAX_ROWS,
	renderCoordinatorBoard,
	type BoardActivity,
	type BoardRow,
	type BoardSnapshot,
} from "../shared/coordinator-board";
import * as data from "./data";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import * as pty from "./pty-server";
import { tmux, ALL_PANE_ACTIVITY_FORMAT } from "./tmux";
import { parseDev3SessionName } from "./tmux/session-names";
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
 * Newest tmux activity per task, keyed by the 8-char id its session name
 * carries. One `list-panes -a` per socket; a task's windows may report several
 * times, and the freshest one is the task's.
 */
async function tmuxActivityByShortId(tasks: Task[]): Promise<Map<string, number>> {
	const sockets = new Set<string>();
	for (const task of tasks) sockets.add(pty.getSessionSocket(task.id));

	const newest = new Map<string, number>();
	for (const socket of sockets) {
		let rows: Array<{ windowActivity: number; sessionName: string }>;
		try {
			rows = await tmux.listPanes(ALL_PANE_ACTIVITY_FORMAT, { scope: "server", socket });
		} catch (err) {
			// A dead or absent server is not an error here — those tasks simply
			// report no session. It must never read as "quiet".
			log.debug("could not list panes for the board snapshot", { socket, error: String(err) });
			continue;
		}
		for (const row of rows) {
			const parsed = parseDev3SessionName(row.sessionName);
			if (!parsed || parsed.kind !== "task") continue;
			if (!Number.isFinite(row.windowActivity) || row.windowActivity <= 0) continue;
			const at = row.windowActivity * 1000;
			const previous = newest.get(parsed.shortId);
			if (previous === undefined || at > previous) newest.set(parsed.shortId, at);
		}
	}
	return newest;
}

function activityOf(task: Task, tmuxActivity: Map<string, number>, nowMs: number): BoardActivity {
	if (task.draft) return { kind: "no-session", reason: "draft" };
	if (task.hibernated) return { kind: "no-session", reason: "hibernated" };

	if (taskTerminalBackendIdentity(task) === "native") {
		// Peek only learns a native pane's time by capturing it, which is far too
		// expensive for every task on every turn. Say so rather than guess.
		return { kind: "unknown" };
	}

	const at = tmuxActivity.get(task.id.slice(0, 8));
	if (at === undefined) {
		return { kind: "no-session", reason: isTaskDisconnected(task) ? "disconnected" : "not running" };
	}
	return { kind: "age", ms: Math.max(0, nowMs - at), granularity: "window" };
}

function toRow(
	task: Task,
	project: Project,
	sharedSeqs: Set<number>,
	tmuxActivity: Map<string, number>,
	nowMs: number,
): BoardRow {
	return {
		taskId: task.id,
		seq: task.seq,
		variantIndex: task.variantIndex ?? null,
		seqShared: sharedSeqs.has(task.seq),
		title: getTaskTitle(task),
		column: columnOf(task, project),
		hibernated: task.hibernated === true,
		draft: task.draft === true,
		activity: activityOf(task, tmuxActivity, nowMs),
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
		return renderCoordinatorBoard(await collectCoordinatorBoard(project, tasks, now), now);
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
export async function collectCoordinatorBoard(
	project: Project,
	tasks: Task[],
	now: Date,
): Promise<BoardSnapshot> {
	const nowMs = now.getTime();

	const live = tasks
		.filter((t) => isLive(t.status as TaskStatus))
		.sort((a, b) => compareTaskSortRank(a, b) || a.seq - b.seq);
	const finished = tasks
		.filter((t) => isFinished(t.status as TaskStatus))
		.filter((t) => nowMs - Date.parse(finishedAt(t)) <= BOARD_FINISHED_WINDOW_MS)
		.sort((a, b) => Date.parse(finishedAt(b)) - Date.parse(finishedAt(a)));

	const tmuxActivity = await tmuxActivityByShortId(live);
	const sharedSeqs = sharedSeqsOf(live);
	const row = (task: Task) => toRow(task, project, sharedSeqs, tmuxActivity, nowMs);

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
