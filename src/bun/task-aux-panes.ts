/**
 * Backend-neutral splitting and ownership of extra task panes (seq 1376, 1394).
 *
 * Two layers live here. {@link splitTaskPane} is the primitive: one new pane in
 * the task's own terminal, on whichever backend that task runs. On top of it sits
 * the auxiliary-pane layer — a pane one ACTION owns while it runs, deduped by
 * purpose.
 *
 * An auxiliary pane is a visible pane in the task's own terminal that one action
 * owns while it runs: the dev-server output, a git operation, a column agent such
 * as the built-in AI Review. Before this module
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
export type AuxPanePurpose = "devServer" | "gitOp" | "columnAgent";

/** Where the new pane lands relative to the pane it splits off. */
export type AuxPanePlacement = "right" | "below";

export interface AuxPaneHandle {
	backend: TaskPaneBackendKind;
	paneId: string;
}

/** What a new pane runs and where — shared by every way of opening one. */
export interface TaskPaneLaunch {
	task: Task;
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

export interface OpenAuxPaneSpec extends TaskPaneLaunch {
	purpose: AuxPanePurpose;
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

interface AuxPanePurposeMeta {
	/**
	 * The temp-file suffix whose path identifies this purpose's pane in a launch
	 * command. Both backends launch a script under the task's temp prefix, so the
	 * prefix alone is a stable, per-task, per-purpose marker.
	 */
	scriptSuffix: string;
	/** English label shown for the pane in the pager and pane picker. */
	title: string;
	/**
	 * Whether replacing this purpose's pane must be PROVEN before a new one opens.
	 * A dev server or a git operation is idempotent enough that a stubborn old pane
	 * is cosmetic; two agents editing one worktree is not, so a column agent
	 * refuses to launch rather than risk a second one.
	 */
	provenReplace: boolean;
}

const AUX_PANE_PURPOSES: Record<AuxPanePurpose, AuxPanePurposeMeta> = {
	devServer: { scriptSuffix: "dev.sh", title: "Dev Server", provenReplace: false },
	gitOp: { scriptSuffix: "git-", title: "Git", provenReplace: false },
	columnAgent: { scriptSuffix: "col-agent.sh", title: "Column Agent", provenReplace: true },
};

/** The substring that identifies a purpose's pane in a launch command. */
export function auxPaneMarker(taskId: string, purpose: AuxPanePurpose): string {
	return dev3TaskTempPath(taskId, AUX_PANE_PURPOSES[purpose].scriptSuffix);
}

/** The English label shown for an auxiliary pane in the pager and pane picker. */
export function auxPaneTitle(purpose: AuxPanePurpose): string {
	return AUX_PANE_PURPOSES[purpose].title;
}

/**
 * The purpose a native pane's launch command belongs to, or null for an ordinary
 * pane. Used to label native panes without storing anything.
 */
export function auxPurposeOfCommand(taskId: string, command: string[]): AuxPanePurpose | null {
	const joined = command.join(" ");
	const purposes = Object.keys(AUX_PANE_PURPOSES) as AuxPanePurpose[];
	return purposes.find((purpose) => joined.includes(auxPaneMarker(taskId, purpose))) ?? null;
}

/**
 * Both backends spell the split the same way: `horizontal` puts the new pane to
 * the right, `vertical` puts it below (tmux `-h`/`-v`, SplitTree orientation).
 */
function orientationFor(placement: AuxPanePlacement): SplitOrientation {
	return placement === "right" ? "horizontal" : "vertical";
}

// ── Finding an existing pane ──────────────────────────────────────────────────

/**
 * `strict` decides what a FAILED lookup means. Best-effort callers read a tmux
 * error as "no session, so no pane" — a task whose tmux session is gone genuinely
 * owns nothing. A caller that is about to open a replacement cannot afford that
 * reading: "I could not look" is not "there is nothing there", and treating it as
 * such is how a second review agent gets to run beside the first.
 */
async function findTmuxAuxPanes(
	task: Task,
	purpose: AuxPanePurpose,
	socket: string,
	strict = false,
): Promise<string[]> {
	const marker = auxPaneMarker(task.id, purpose);
	try {
		const rows = await tmux.listPanes(PANE_START_COMMAND_FORMAT, { target: taskSessionName(task.id), socket });
		return rows.filter((row) => row.startCommand.includes(marker)).map((row) => row.paneId);
	} catch (err) {
		if (err instanceof TmuxError && !strict) return [];
		throw err;
	}
}

async function findNativeAuxPanes(
	task: Task,
	purpose: AuxPanePurpose,
): Promise<{ paneId: string; shellPid: number; alive: boolean }[]> {
	const marker = auxPaneMarker(task.id, purpose);
	const panes = await nativeTaskPaneCommands(task.id);
	return panes
		.filter((pane) => pane.command.join(" ").includes(marker))
		.map((pane) => ({ paneId: pane.paneId, shellPid: pane.shellPid, alive: pane.alive }));
}

/**
 * EVERY pane this purpose currently owns. Normally one, but a crash, a second app
 * instance, or a close that quietly failed can leave more, and a caller that only
 * looked at the first would keep replacing one of them forever.
 */
export async function findAuxPanes(
	task: Task,
	purpose: AuxPanePurpose,
	socket: string,
	/** Fail instead of reporting an empty list when the lookup itself cannot run. */
	options?: { strict?: boolean },
): Promise<AuxPaneHandle[]> {
	if (backendOf(task) === "native") {
		// The native lookup already propagates: an unreadable pane set throws.
		const found = await findNativeAuxPanes(task, purpose);
		return found.map(({ paneId }) => ({ backend: "native" as const, paneId }));
	}
	const paneIds = await findTmuxAuxPanes(task, purpose, socket, options?.strict === true);
	return paneIds.map((paneId) => ({ backend: "tmux" as const, paneId }));
}

/** The first pane this purpose owns, or null. */
export async function findAuxPane(task: Task, purpose: AuxPanePurpose, socket: string): Promise<AuxPaneHandle | null> {
	return (await findAuxPanes(task, purpose, socket))[0] ?? null;
}

/**
 * True when the purpose owns a pane whose process is still running. A native
 * pane whose command exited lingers as a dead pane showing its last output —
 * visible, but not alive.
 */
export async function auxPaneAlive(task: Task, purpose: AuxPanePurpose, socket: string): Promise<boolean> {
	if (backendOf(task) === "native") {
		return (await findNativeAuxPanes(task, purpose)).some((pane) => pane.alive);
	}
	return (await findTmuxAuxPanes(task, purpose, socket)).length > 0;
}

/** The pid of the process running in the purpose's native pane, or null. */
export async function nativeAuxPaneShellPid(task: Task, purpose: AuxPanePurpose): Promise<number | null> {
	const found = await findNativeAuxPanes(task, purpose);
	return found.find((pane) => pane.alive)?.shellPid ?? null;
}

// ── Opening and closing ───────────────────────────────────────────────────────

/**
 * Close every pane this purpose owns. Idempotent, and best-effort by design:
 * a pane that is already gone is the desired end state, not an error.
 */
export async function closeAuxPane(task: Task, purpose: AuxPanePurpose, socket: string): Promise<void> {
	for (const handle of await findAuxPanes(task, purpose, socket)) {
		if (handle.backend === "native") {
			await closeNativeTaskPane(task.id, handle.paneId).catch((err) =>
				log.warn("closeAuxPane: native pane close failed", { taskId: task.id.slice(0, 8), purpose, error: String(err) }),
			);
		} else {
			await tmux.killPane(handle.paneId, { socket, bestEffort: true });
		}
		log.info("Closed auxiliary pane", { taskId: task.id.slice(0, 8), purpose, backend: handle.backend, paneId: handle.paneId });
	}
}

/**
 * A purpose whose replacement must be proven could not clear the panes it already
 * owns, so opening another one would leave two of them running. The launch is
 * refused instead.
 */
/**
 * The pane set could not be read, so whether this purpose already owns a pane is
 * unknown. Refusing is the only safe answer: assuming "none" is what lets a second
 * agent run beside the first.
 */
export class AuxPaneUndecidableError extends Error {
	constructor(readonly purpose: AuxPanePurpose, cause: unknown) {
		super(
			`could not check whether this task already has a ${purpose} pane, so the launch was refused: ` +
				`${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "AuxPaneUndecidableError";
	}
}

export class AuxPaneReplaceError extends Error {
	constructor(readonly purpose: AuxPanePurpose, readonly remaining: string[], cause?: unknown) {
		super(
			`could not close the ${purpose} pane${remaining.length === 1 ? "" : "s"} a previous run left behind` +
				`${remaining.length ? ` (${remaining.join(", ")} still present)` : ""}` +
				`${cause ? `: ${cause instanceof Error ? cause.message : String(cause)}` : ""}`,
		);
		this.name = "AuxPaneReplaceError";
	}
}

/**
 * Close every pane the purpose owns and PROVE they are gone. Unlike
 * {@link closeAuxPane}, nothing here is best-effort — not the close, and not the
 * LOOKUP: only an observed empty list may let a replacement open, so a lookup
 * that could not run fails the launch instead of reading as "there was nothing".
 */
async function replaceAuxPanes(task: Task, purpose: AuxPanePurpose, socket: string): Promise<void> {
	const existing = await findOwnedPanesStrictly(task, purpose, socket);
	for (const handle of existing) {
		try {
			await closeTaskPane(task, handle, socket);
		} catch (err) {
			throw new AuxPaneReplaceError(purpose, [handle.paneId], err);
		}
		log.info("Closed auxiliary pane", { taskId: task.id.slice(0, 8), purpose, backend: handle.backend, paneId: handle.paneId });
	}
	// Re-read rather than trusting the closes: the pane set is the authority, and
	// a pane that reappears (or was never listed) must still block the launch.
	const remaining = await findOwnedPanesStrictly(task, purpose, socket);
	if (remaining.length > 0) {
		throw new AuxPaneReplaceError(purpose, remaining.map((handle) => handle.paneId));
	}
}

/** The purpose's panes, where a failed lookup is a failure and not an empty set. */
async function findOwnedPanesStrictly(
	task: Task,
	purpose: AuxPanePurpose,
	socket: string,
): Promise<AuxPaneHandle[]> {
	try {
		return await findAuxPanes(task, purpose, socket, { strict: true });
	} catch (err) {
		throw new AuxPaneUndecidableError(purpose, err);
	}
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
	const { task, purpose, socket } = spec;
	if (AUX_PANE_PURPOSES[purpose].provenReplace) {
		await replaceAuxPanes(task, purpose, socket);
	} else {
		await closeAuxPane(task, purpose, socket);
	}
	const handle = await splitTaskPane({ ...spec, restoreFocus: true });
	log.info("Opened auxiliary pane", {
		taskId: task.id.slice(0, 8),
		purpose,
		backend: handle.backend,
		paneId: handle.paneId,
	});
	return handle;
}

// ── The backend-neutral primitive ─────────────────────────────────────────────

export interface SplitTaskPaneSpec extends TaskPaneLaunch {
	/** tmux split target — a session name or a pane id. Defaults to the task session. */
	tmuxTarget?: string;
	/** Native pane to split off. Defaults to the pane that currently has focus. */
	nativeAnchor?: string;
	/** Native only: hand focus back to the pane that had it before the split. */
	restoreFocus?: boolean;
}

/**
 * Open ONE new pane in the task's terminal, on whichever backend that task runs.
 *
 * The native path never calls tmux and never probes a tmux socket; the tmux path
 * is byte-identical to the raw `split-window` it replaces. A backend that has no
 * pane to split off throws {@link AuxPaneUnavailableError} — never a silent no-op
 * and never a tmux fallback.
 */
export async function splitTaskPane(spec: SplitTaskPaneSpec): Promise<AuxPaneHandle> {
	const { task, placement, size, cwd, socket, title } = spec;
	// Every extra pane gets the task number, so a native auxiliary host is as
	// readable in a process viewer as the agent's own (seq 1383). Set here rather
	// than at each call site: a future caller inherits it by construction.
	const env = { [TASK_SEQ_ENV]: taskSeqLabel(task), ...spec.env };

	if (backendOf(task) === "native") {
		const state = await nativeTaskPanesState(task.id);
		if (!state || state.panes.length === 0) throw new AuxPaneUnavailableError("terminal-not-running");
		const anchor = spec.nativeAnchor || state.activePaneId || state.panes[0].paneId;
		const previouslyActive = state.activePaneId || null;

		const { paneId } = await splitNativeTaskPane(task.id, anchor, orientationFor(placement), {
			cwd,
			env,
			launch: spec.nativeLaunch,
		});

		if (spec.restoreFocus && previouslyActive && previouslyActive !== paneId) {
			await focusNativeTaskPane(task.id, previouslyActive).catch((err) =>
				log.warn("splitTaskPane: could not restore focus to the previous pane", {
					taskId: task.id.slice(0, 8),
					previouslyActive,
					error: String(err),
				}),
			);
		}
		log.info("Split a native task pane", { taskId: task.id.slice(0, 8), paneId, anchor });
		return { backend: "native", paneId };
	}

	try {
		const { paneId, stderr } = await tmux.splitWindow({
			target: spec.tmuxTarget || taskSessionName(task.id),
			orientation: orientationFor(placement),
			size,
			printPaneId: true,
			env,
			cwd,
			command: spec.tmuxCommand,
			socket,
		});
		if (stderr.trim()) log.warn("splitTaskPane tmux stderr", { stderr: stderr.trim() });
		// AWAITED on purpose. `select-pane -t` sets the title AND makes that pane
		// active, so a fire-and-forget call can land after the caller has already
		// focused the pane it wants and silently steal focus back.
		if (paneId && title) {
			await tmux.selectPane(paneId, { socket, title }).catch(() => {});
		}
		log.info("Split a tmux task pane", { taskId: task.id.slice(0, 8), paneId });
		return { backend: "tmux", paneId: paneId ?? "" };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		if (err.stderr) log.warn("splitTaskPane tmux stderr", { stderr: err.stderr });
		throw new Error(`tmux split-window failed (exit ${err.exitCode}): ${err.stderr || "unknown error"}`);
	}
}

/**
 * Close one pane the caller opened, on whichever backend it lives, and PROVE it
 * is gone. Deliberately not best-effort: the caller undoing a half-finished
 * launch has to be able to say whether the panes really went away, and a
 * swallowed failure there turns into a user-facing lie ("none were kept" while
 * two panes are still on screen).
 */
export async function closeTaskPane(task: Task, handle: AuxPaneHandle, socket: string): Promise<void> {
	if (handle.backend === "native") {
		const { state } = await closeNativeTaskPane(task.id, handle.paneId);
		if (state?.panes.some((pane) => pane.paneId === handle.paneId)) {
			throw new Error(`native pane ${handle.paneId} is still in the pane set after closing it`);
		}
		return;
	}
	await tmux.killPane(handle.paneId, { socket });
}
