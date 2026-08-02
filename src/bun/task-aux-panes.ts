/**
 * Backend-neutral ownership of AUXILIARY task panes (seq 1376).
 *
 * An auxiliary pane is a visible pane in the task's own terminal that one action
 * owns while it runs: the dev-server output, a git operation. Before this module
 * every such pane was a raw `tmux split-window` against `dev3-task-<id>`, so on a
 * native task the split hit a session that does not exist — the git panes threw,
 * and the dev-server pane failed inside a best-effort catch, leaving the dev
 * script running invisibly. See the audit note on task 987a4829.
 *
 * OWNERSHIP IS DERIVED, NOT REMEMBERED. A pane is re-found by the command it was
 * launched with, exactly as the tmux code has always re-found its own panes with
 * `#{pane_start_command}`. Nothing is cached in RAM (which an app restart would
 * lose while the pane lives on) and nothing new is written under `~/.dev3.0/`.
 *
 * The caller supplies what each backend runs, because the two are not always the
 * same program: the tmux dev-server pane runs a re-attach loop into a nested
 * session, while the native pane runs the dev script itself. Everything around
 * that — placement, dedup, focus safety, labels — lives here.
 *
 * The native path NEVER calls tmux, and the tmux path is byte-identical to what
 * it did before.
 */

import type { Task } from "../shared/types";
import { taskSeqLabel } from "../shared/types";
import type { TaskPaneBackendKind } from "../shared/task-panes";
import type { SplitOrientation } from "../shared/split-tree";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import type { TerminalLaunchSpec } from "./task-terminal-backend";
import { tmux, taskSessionName, TmuxError, PANE_START_COMMAND_FORMAT } from "./tmux";
import {
	closeNativeTaskPane,
	focusNativeTaskPane,
	nativeTaskPaneCommands,
	nativeTaskPanesState,
	splitNativeTaskPane,
} from "./native-task-panes";
import { TASK_SEQ_ENV } from "./native-terminal-registry/process-naming";
import { dev3TaskTempPath } from "./temp-paths";
import { createLogger } from "./logger";

const log = createLogger("task-aux-panes");

/** Which action owns the pane. One live pane per purpose per task, at most. */
export type AuxPanePurpose = "devServer" | "gitOp";

/** Where the new pane lands relative to the pane it splits off. */
export type AuxPanePlacement = "right" | "below";

export interface AuxPaneHandle {
	backend: TaskPaneBackendKind;
	paneId: string;
}

export interface OpenAuxPaneSpec {
	task: Task;
	purpose: AuxPanePurpose;
	placement: AuxPanePlacement;
	/** tmux-only pane size (e.g. "50%"); the native SplitTree always splits evenly. */
	size: string;
	cwd: string;
	env?: Record<string, string>;
	socket: string;
	/** English pane title; tmux sets it on the pane, native derives it back from the command. */
	title?: string;
	/** What each backend runs. Often the same script, but not always. */
	tmuxCommand: string;
	nativeLaunch: TerminalLaunchSpec;
}

/**
 * A pane was asked for on a backend that cannot provide one right now. Callers
 * turn this into a disabled control with a reason — never into a silent no-op,
 * and never into a tmux fallback.
 */
export class AuxPaneUnavailableError extends Error {
	constructor(readonly reason: "terminal-not-running") {
		super("the task terminal is not running, so it has no pane to split");
		this.name = "AuxPaneUnavailableError";
	}
}

function backendOf(task: Task): TaskPaneBackendKind {
	return taskTerminalBackendIdentity(task);
}

/**
 * The substring that identifies a purpose's pane in a launch command. Both
 * backends launch a script under the task's temp prefix, so the prefix alone is
 * a stable, per-task, per-purpose marker.
 */
export function auxPaneMarker(taskId: string, purpose: AuxPanePurpose): string {
	return purpose === "devServer"
		? dev3TaskTempPath(taskId, "dev.sh")
		: `${dev3TaskTempPath(taskId, "git-")}`;
}

/** The English label shown for an auxiliary pane in the pager and pane picker. */
export function auxPaneTitle(purpose: AuxPanePurpose): string {
	return purpose === "devServer" ? "Dev Server" : "Git";
}

/**
 * The purpose a native pane's launch command belongs to, or null for an ordinary
 * pane. Used to label native panes without storing anything.
 */
export function auxPurposeOfCommand(taskId: string, command: string[]): AuxPanePurpose | null {
	const joined = command.join(" ");
	if (joined.includes(auxPaneMarker(taskId, "devServer"))) return "devServer";
	if (joined.includes(auxPaneMarker(taskId, "gitOp"))) return "gitOp";
	return null;
}

/**
 * Both backends spell the split the same way: `horizontal` puts the new pane to
 * the right, `vertical` puts it below (tmux `-h`/`-v`, SplitTree orientation).
 */
function orientationFor(placement: AuxPanePlacement): SplitOrientation {
	return placement === "right" ? "horizontal" : "vertical";
}

// ── Finding an existing pane ──────────────────────────────────────────────────

async function findTmuxAuxPane(task: Task, purpose: AuxPanePurpose, socket: string): Promise<string | null> {
	const marker = auxPaneMarker(task.id, purpose);
	try {
		const rows = await tmux.listPanes(PANE_START_COMMAND_FORMAT, { target: taskSessionName(task.id), socket });
		return rows.find((row) => row.startCommand.includes(marker))?.paneId ?? null;
	} catch (err) {
		if (err instanceof TmuxError) return null;
		throw err;
	}
}

async function findNativeAuxPane(task: Task, purpose: AuxPanePurpose): Promise<{ paneId: string; shellPid: number; alive: boolean } | null> {
	const marker = auxPaneMarker(task.id, purpose);
	const panes = await nativeTaskPaneCommands(task.id);
	const found = panes.find((pane) => pane.command.join(" ").includes(marker));
	return found ? { paneId: found.paneId, shellPid: found.shellPid, alive: found.alive } : null;
}

/** The pane this purpose currently owns, or null. */
export async function findAuxPane(task: Task, purpose: AuxPanePurpose, socket: string): Promise<AuxPaneHandle | null> {
	if (backendOf(task) === "native") {
		const found = await findNativeAuxPane(task, purpose);
		return found ? { backend: "native", paneId: found.paneId } : null;
	}
	const paneId = await findTmuxAuxPane(task, purpose, socket);
	return paneId ? { backend: "tmux", paneId } : null;
}

/**
 * True when the purpose owns a pane whose process is still running. A native
 * pane whose command exited lingers as a dead pane showing its last output —
 * visible, but not alive.
 */
export async function auxPaneAlive(task: Task, purpose: AuxPanePurpose, socket: string): Promise<boolean> {
	if (backendOf(task) === "native") {
		const found = await findNativeAuxPane(task, purpose);
		return found?.alive === true;
	}
	return (await findTmuxAuxPane(task, purpose, socket)) !== null;
}

/** The pid of the process running in the purpose's native pane, or null. */
export async function nativeAuxPaneShellPid(task: Task, purpose: AuxPanePurpose): Promise<number | null> {
	const found = await findNativeAuxPane(task, purpose);
	return found && found.alive ? found.shellPid : null;
}

// ── Opening and closing ───────────────────────────────────────────────────────

/**
 * Close whatever pane this purpose owns. Idempotent, and best-effort by design:
 * a pane that is already gone is the desired end state, not an error.
 */
export async function closeAuxPane(task: Task, purpose: AuxPanePurpose, socket: string): Promise<void> {
	const handle = await findAuxPane(task, purpose, socket);
	if (!handle) return;
	if (handle.backend === "native") {
		await closeNativeTaskPane(task.id, handle.paneId).catch((err) =>
			log.warn("closeAuxPane: native pane close failed", { taskId: task.id.slice(0, 8), purpose, error: String(err) }),
		);
	} else {
		await tmux.killPane(handle.paneId, { socket, bestEffort: true });
	}
	log.info("Closed auxiliary pane", { taskId: task.id.slice(0, 8), purpose, backend: handle.backend, paneId: handle.paneId });
}

/**
 * Open the purpose's pane, replacing any pane it already owns so a repeated
 * click can never stack a second one (this also sweeps a native pane left dead
 * by a previous run).
 *
 * On native, focus is handed back to the pane that had it — a new pane becomes
 * the coordinator's active pane on split, and the agent must not lose input just
 * because a dev server started.
 */
export async function openAuxPane(spec: OpenAuxPaneSpec): Promise<AuxPaneHandle> {
	const { task, purpose, placement, size, cwd, socket, title } = spec;
	// Every purpose's pane gets the task number, so a native auxiliary host is as
	// readable in a process viewer as the agent's own (seq 1383). Set here rather
	// than at each call site: a future purpose inherits it by construction.
	const env = { [TASK_SEQ_ENV]: taskSeqLabel(task), ...spec.env };
	await closeAuxPane(task, purpose, socket);

	if (backendOf(task) === "native") {
		const state = await nativeTaskPanesState(task.id);
		if (!state || state.panes.length === 0) throw new AuxPaneUnavailableError("terminal-not-running");
		const anchor = state.activePaneId || state.panes[0].paneId;
		const previouslyActive = state.activePaneId || null;

		const { paneId } = await splitNativeTaskPane(task.id, anchor, orientationFor(placement), {
			cwd,
			env,
			launch: spec.nativeLaunch,
		});

		if (previouslyActive && previouslyActive !== paneId) {
			await focusNativeTaskPane(task.id, previouslyActive).catch((err) =>
				log.warn("openAuxPane: could not restore focus to the previous pane", {
					taskId: task.id.slice(0, 8),
					previouslyActive,
					error: String(err),
				}),
			);
		}
		log.info("Opened native auxiliary pane", { taskId: task.id.slice(0, 8), purpose, paneId, anchor });
		return { backend: "native", paneId };
	}

	try {
		const { paneId, stderr } = await tmux.splitWindow({
			target: taskSessionName(task.id),
			orientation: orientationFor(placement),
			size,
			printPaneId: true,
			env,
			cwd,
			command: spec.tmuxCommand,
			socket,
		});
		if (stderr.trim()) log.warn("openAuxPane tmux stderr", { stderr: stderr.trim() });
		if (paneId && title) {
			tmux.selectPane(paneId, { socket, title }).catch(() => {});
		}
		log.info("Opened tmux auxiliary pane", { taskId: task.id.slice(0, 8), purpose, paneId });
		return { backend: "tmux", paneId: paneId ?? "" };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		if (err.stderr) log.warn("openAuxPane tmux stderr", { stderr: err.stderr });
		throw new Error(`tmux split-window failed (exit ${err.exitCode}): ${err.stderr || "unknown error"}`);
	}
}
