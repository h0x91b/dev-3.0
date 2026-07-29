/**
 * The single implementation of "which backend owns this task's terminal right
 * now" and "may it be switched" (seq 1352).
 *
 * Both operator surfaces — the CLI (`dev3 task terminal-backend`) and the GUI
 * per-task override in the Task Detail modal — route through here so they can
 * never drift apart on the one rule that matters: live terminal state is never
 * migrated between backends. A switch is refused while either backend still owns
 * a session for the task, and a refusal mutates nothing on either side.
 */

import type { NativeTerminalAvailability, Project, Task } from "../shared/types";
import { isTerminalBackendIdentity, type TerminalBackendIdentity } from "../shared/terminal-backend-identity";
import * as data from "./data";
import { nativeTaskPanesAlive } from "./native-task-panes";
import { NativeHostRuntimeError, resolveNativeHostRuntime } from "./native-host-runtime";
import { tmuxSessionExists } from "./pty-server";

/** A switch this build refuses to perform; nothing was written when it is thrown. */
export class TerminalBackendSwitchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TerminalBackendSwitchError";
	}
}

export interface TaskTerminalBackendState {
	/** Effective identity — the persisted value, or `tmux` for an unmarked task. */
	backend: TerminalBackendIdentity;
	/** Whether the task record actually carries the field. */
	explicit: boolean;
	/** The backend that owns a live session for this task, or null when stopped. */
	liveBackend: TerminalBackendIdentity | null;
}

/** Which backend currently owns a session for this task. Read-only on both sides. */
export async function liveTaskTerminalBackend(task: Task): Promise<TerminalBackendIdentity | null> {
	if (await nativeTaskPanesAlive(task.id)) return "native";
	if (await tmuxSessionExists(task.id, task.tmuxSocket ?? undefined)) return "tmux";
	return null;
}

/**
 * Read the persisted identity plus the live owner. Throws on an unreadable
 * stored value rather than guessing — the caller shows the repair instruction.
 */
export async function readTaskTerminalBackendState(task: Task): Promise<TaskTerminalBackendState> {
	const current = data.readTaskTerminalBackend(task);
	if (!current.ok) {
		throw new TerminalBackendSwitchError(
			`Task ${task.id.slice(0, 8)} has an unreadable terminalBackend (${current.code}: ${JSON.stringify(current.received)}). ` +
				"Repair it with --to tmux.",
		);
	}
	return { backend: current.backend, explicit: current.present, liveBackend: await liveTaskTerminalBackend(task) };
}

/**
 * Flip the persisted identity for a stopped task. Refuses — writing nothing —
 * when the target is unknown, or when a live session still exists on either
 * backend and the target differs from the current one. Re-selecting the backend
 * a live session already runs on is allowed because it changes nothing.
 */
export async function switchTaskTerminalBackend(
	project: Project,
	task: Task,
	target: string,
): Promise<{ task: Task; state: TaskTerminalBackendState }> {
	if (!isTerminalBackendIdentity(target)) {
		throw new TerminalBackendSwitchError(`Invalid terminal backend "${target}". Use tmux or native.`);
	}
	const current = await readTaskTerminalBackendState(task);
	if (current.liveBackend && target !== current.backend) {
		throw new TerminalBackendSwitchError(
			`Task ${task.id.slice(0, 8)} still has a live ${current.liveBackend} terminal. Stop it first ` +
				"(move the task out of progress, or restart it after switching) — dev3 never transfers live terminal state between backends.",
		);
	}
	const updated = await data.setTaskTerminalBackend(project, task.id, target);
	return { task: updated, state: { backend: target, explicit: true, liveBackend: current.liveBackend } };
}

/**
 * Non-throwing probe of this build's native terminal host — the gate the UI uses
 * before offering `native`. Never falls back to tmux and never caches: an in-app
 * update can stage a usable host image mid-session. `tmuxSupported` answers for
 * the HOST platform, so a browser attached from another OS still sees the truth.
 */
export function nativeTerminalAvailability(
	platform: NodeJS.Platform = process.platform,
): NativeTerminalAvailability {
	const tmuxSupported = platform !== "win32";
	try {
		const runtime = resolveNativeHostRuntime();
		return { available: true, tmuxSupported, origin: runtime.origin, diagnostics: [] };
	} catch (err) {
		if (err instanceof NativeHostRuntimeError) {
			return { available: false, tmuxSupported, diagnostics: err.diagnostics };
		}
		return { available: false, tmuxSupported, diagnostics: [String(err)] };
	}
}
