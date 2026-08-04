/**
 * `dev3 peek` — compose a read-only activity snapshot of ONE task's terminal
 * for a coordinating agent (seq 1410).
 *
 * Backend parity is the point: a tmux task and a native task answer with the
 * same fields and the same meanings, and the one place they genuinely differ
 * (per-pane vs per-window activity time) is named in the payload rather than
 * papered over. Nothing here writes, focuses, or resizes, and no read opens a
 * write channel — the native tail is an observational capture (decision 202), so
 * a peek is invisible from inside the peeked task.
 *
 * Freshness sources:
 *  - tmux: `#{window_activity}`, because tmux has no per-pane activity variable
 *    (verified on a live tmux 3.6a) — reported with `granularity: "window"`.
 *  - native: the capture's own `sourceUpdatedAt`, for the pane we captured. There
 *    is no cheap per-pane time for the others, so they report unknown rather than
 *    borrowing a clock. Production returns `not-enabled` today (decision 202):
 *    the host publishes no capture artifact, and peek says so instead of guessing.
 */

import type { Task, TaskStatus } from "../shared/types";
import {
	clampPeekLines,
	selectPeekPane,
	tailLines,
	type PeekBackend,
	type PeekPane,
	type PeekUnavailable,
	type TaskPeekSnapshot,
} from "../shared/task-peek";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { auxPaneTitle, auxPurposeOfCommand } from "./task-aux-panes";
import {
	captureNativeTaskPane,
	nativeTaskPaneCommandsOf,
	nativeTaskPanesState,
} from "./native-task-panes";
import { isCapturedPane, type TerminalPaneCapture } from "./task-terminal-backend";
import * as pty from "./pty-server";
import { tmux, CAPTURE_SCROLLBACK_START_LINE, PEEK_PANE_FORMAT } from "./tmux";
import { createLogger } from "./logger";

const log = createLogger("task-peek");

export interface TaskPeekParams {
	task: Task;
	/** 1-based pane number or a raw backend pane id; focused pane when omitted. */
	pane?: string;
	/** Tail budget in lines; clamped to the shared default/cap. */
	lines?: number;
}

/** Draft and hibernated are task properties, not runtime phases — checked first. */
function noSession(task: Task): PeekUnavailable {
	return { kind: "no-session", detail: noSessionDetail(task) };
}

function noSessionDetail(task: Task): string {
	if (task.draft) return "task is a draft and was never started";
	if (task.hibernated) return "task is hibernated — its terminal was torn down to reclaim memory";
	const runtime = task.runtimeState?.runtime;
	if (runtime && runtime !== "idle") {
		return `runtime is ${runtime} but no terminal session answered`;
	}
	return `task is not running (status ${task.status})`;
}

function header(task: Task, backend: PeekBackend, observedAt: string) {
	return {
		taskId: task.id,
		seq: task.seq ?? null,
		title: task.title,
		status: task.status as TaskStatus,
		backend,
		observedAt,
	} as const;
}

/** Nothing to look at. `unavailable` says whether that is the task's state or our failure. */
function emptySnapshot(
	task: Task,
	backend: PeekBackend,
	observedAt: string,
	unavailable: PeekUnavailable,
): TaskPeekSnapshot {
	return { ...header(task, backend, observedAt), sessionPresent: false, unavailable, panes: [], tail: null };
}

/** A session exists; `unavailable` is set only when the requested pane was not found. */
function liveSnapshot(
	task: Task,
	backend: PeekBackend,
	observedAt: string,
	panes: PeekPane[],
	tail: TaskPeekSnapshot["tail"],
	unavailable: PeekUnavailable | null = null,
): TaskPeekSnapshot {
	return { ...header(task, backend, observedAt), sessionPresent: true, unavailable, panes, tail };
}

/** A pane the caller named that the session does not have. */
function paneNotFound(selector: string | undefined): PeekUnavailable {
	return { kind: "pane-not-found", detail: `no pane "${selector ?? "(focused)"}" in this session` };
}

/** Tail payload for one pane, counting the lines the text actually holds. */
/** Age of a pane's last output at the moment we observed it. */
function ageAt(observedAt: string, lastOutputAt: string | null): number | null {
	if (lastOutputAt === null) return null;
	return Math.max(0, Date.parse(observedAt) - Date.parse(lastOutputAt));
}

function tailOf(pane: PeekPane, text: string): TaskPeekSnapshot["tail"] {
	return {
		paneIndex: pane.index,
		paneId: pane.paneId,
		lines: text === "" ? 0 : text.split("\n").length,
		text,
	};
}

/**
 * Prefer the pane title: `pane_current_command` names the wrapper shell (`zsh`)
 * for an agent launched from a script, while agents keep their title current.
 */
function tmuxPaneLabel(row: { command: string; hostShort: string; title: string }): string {
	const title = row.title.trim();
	const meaningfulTitle = title && title !== row.hostShort.trim() ? title : "";
	return meaningfulTitle || row.command.trim();
}

/** Native equivalent: the pane's known purpose, else its launch executable. */
function nativePaneLabel(taskId: string, command: string[] | undefined): string {
	const purpose = command ? auxPurposeOfCommand(taskId, command) : null;
	if (purpose) return auxPaneTitle(purpose);
	const executable = command?.[0]?.trim();
	return executable ? (executable.split("/").pop() ?? "") : "";
}

/** Epoch seconds from tmux → ISO, or null when tmux reported nothing usable. */
function tmuxActivityToIso(epochSeconds: number): string | null {
	if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
	return new Date(epochSeconds * 1000).toISOString();
}

async function tmuxPeek(task: Task, params: TaskPeekParams, observedAt: string): Promise<TaskPeekSnapshot> {
	const socket = pty.getSessionSocket(task.id);
	const session = pty.getSessionTmuxName(task.id);

	if (!(await tmux.hasSession(session, { socket }))) {
		return emptySnapshot(task, "tmux", observedAt, noSession(task));
	}

	const rows = await tmux.listPanes(PEEK_PANE_FORMAT, { target: session, scope: "session", socket });
	if (rows.length === 0) return emptySnapshot(task, "tmux", observedAt, noSession(task));

	const panes: PeekPane[] = rows.map((row, i) => {
		const lastOutputAt = tmuxActivityToIso(row.windowActivity);
		return {
			index: i + 1,
			paneId: row.paneId,
			label: tmuxPaneLabel(row),
			alive: !row.dead,
			focused: row.active,
			lastOutputAt,
			lastOutputAgeMs: ageAt(observedAt, lastOutputAt),
			granularity: "window",
		};
	});

	const lines = clampPeekLines(params.lines);
	const chosen = selectPeekPane(panes, params.pane);
	if (!chosen) return liveSnapshot(task, "tmux", observedAt, panes, null, paneNotFound(params.pane));

	const captured = await tmux.capturePane({
		target: chosen.paneId,
		startLine: CAPTURE_SCROLLBACK_START_LINE,
		socket,
	});
	return liveSnapshot(task, "tmux", observedAt, panes, tailOf(chosen, tailLines(captured, lines)));
}

/**
 * A capture miss, in peek's vocabulary. `view-absent` is the caller naming a pane
 * that is gone; everything else is us failing to read a pane that exists, which
 * must never read as "the task is quiet".
 */
function missToUnavailable(capture: Extract<TerminalPaneCapture, { availability: string }>): PeekUnavailable {
	const reason = "reason" in capture ? capture.reason : "no detail";
	if (capture.availability === "view-absent") {
		return { kind: "pane-not-found", detail: reason };
	}
	return { kind: "read-failed", detail: `${capture.availability}: ${reason}` };
}

async function nativePeek(task: Task, params: TaskPeekParams, observedAt: string): Promise<TaskPeekSnapshot> {
	const state = await nativeTaskPanesState(task.id);
	if (!state || state.panes.length === 0) return emptySnapshot(task, "native", observedAt, noSession(task));

	const commands = new Map(nativeTaskPaneCommandsOf(state).map((p) => [p.paneId, p.command]));

	// Freshness per pane would cost one capture per pane, so only the pane we
	// actually read reports a time; the rest say unknown rather than borrow one.
	const panes: PeekPane[] = state.panes.map((pane, i) => ({
		index: i + 1,
		paneId: pane.paneId,
		label: nativePaneLabel(task.id, commands.get(pane.paneId)),
		alive: pane.alive,
		focused: pane.paneId === state.activePaneId,
		lastOutputAt: null,
		lastOutputAgeMs: null,
		granularity: "pane",
	}));

	const lines = clampPeekLines(params.lines);
	const chosen = selectPeekPane(panes, params.pane);
	if (!chosen) return liveSnapshot(task, "native", observedAt, panes, null, paneNotFound(params.pane));

	const capture = await captureNativeTaskPane(task.id, chosen.paneId, lines);
	if (!isCapturedPane(capture)) {
		return liveSnapshot(task, "native", observedAt, panes, null, missToUnavailable(capture));
	}

	const pane = panes[chosen.index - 1];
	if (capture.sourceUpdatedAt.known) {
		pane.lastOutputAt = capture.sourceUpdatedAt.value;
		pane.lastOutputAgeMs = ageAt(observedAt, capture.sourceUpdatedAt.value);
	}
	pane.alive = capture.liveness === "dead" ? false : pane.alive;

	const text = tailLines([...capture.content.history, ...capture.content.viewport].join("\n"), lines);
	return liveSnapshot(task, "native", observedAt, panes, tailOf(chosen, text));
}

/**
 * Read-only activity snapshot for one task. Never throws for an absent session
 * — a missing terminal is an answer ("no terminal session, because …"), not a
 * failure, since "is it alive?" is exactly what the caller asked.
 */
export async function taskPeek(params: TaskPeekParams): Promise<TaskPeekSnapshot> {
	const { task } = params;
	const observedAt = new Date().toISOString();
	const backend = taskTerminalBackendIdentity(task);

	// Metadata only: terminal text must never reach the shared logs.
	log.debug("peek", {
		taskId: task.id.slice(0, 8),
		backend,
		pane: params.pane ?? "(focused)",
		lines: clampPeekLines(params.lines),
	});

	try {
		return backend === "native"
			? await nativePeek(task, params, observedAt)
			: await tmuxPeek(task, params, observedAt);
	} catch (err) {
		log.warn("peek failed to read the terminal", { taskId: task.id.slice(0, 8), backend, error: String(err) });
		return emptySnapshot(task, backend, observedAt, { kind: "read-failed", detail: String(err) });
	}
}
