/**
 * In-memory registry for package.json scripts launched into a task's tmux session.
 *
 * Scope (V1):
 *   - Tracks one tmux pane per (taskId, scriptName).
 *   - Runs a script via tmux split-window in the chosen placement; reruns by
 *     send-keys'ing the runner command into the existing pane.
 *   - Lazy exit detection: when the pane disappears (tmux kill-pane / user
 *     closed it) we mark the script as "stale" on the next state probe.
 *   - Stop = SIGINT to pane pid; Kill = tmux kill-pane.
 *
 * Out of scope (deferred):
 *   - Exit-code reporting (would need a tmux pane-died hook or wrapper script).
 *   - Dev Server integration (Dev Server still uses its own session/viewer pane;
 *     migration tracked as a separate task).
 */
import type {
	PackageScripts,
	ScriptPlacement,
	ScriptRunner,
	ScriptState,
	Task,
} from "../shared/types";
import * as pty from "./pty-server";
import { spawn } from "./spawn";
import { resolveRunnerCommand } from "./package-scripts";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("script-runner");

const taskSessionName = (taskId: string): string => `dev3-${taskId.slice(0, 8)}`;

/** taskId → scriptName → state */
const registry = new Map<string, Map<string, ScriptState>>();

function getOrCreateTaskMap(taskId: string): Map<string, ScriptState> {
	let m = registry.get(taskId);
	if (!m) {
		m = new Map();
		registry.set(taskId, m);
	}
	return m;
}

async function paneExists(socket: string, paneId: string): Promise<boolean> {
	if (!paneId) return false;
	const proc = spawn(
		pty.tmuxArgs(socket, "display-message", "-p", "-t", paneId, "#{pane_id}"),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const code = await proc.exited;
	return code === 0;
}

async function panePid(socket: string, paneId: string): Promise<number | null> {
	const proc = spawn(
		pty.tmuxArgs(socket, "display-message", "-p", "-t", paneId, "#{pane_pid}"),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	if (code !== 0) return null;
	const pid = parseInt(out.trim(), 10);
	return Number.isFinite(pid) ? pid : null;
}

/**
 * Probe every state for this task and update status if its pane disappeared.
 * Cheap enough to call on each getScriptStates / runScript invocation.
 */
async function refreshTaskStates(taskId: string, socket: string): Promise<void> {
	const m = registry.get(taskId);
	if (!m) return;
	for (const [name, state] of m.entries()) {
		if (state.status === "running" && state.paneId) {
			const alive = await paneExists(socket, state.paneId);
			if (!alive) {
				m.set(name, {
					...state,
					status: "stale",
					paneId: null,
					exitedAt: new Date().toISOString(),
				});
			}
		}
	}
}

function broadcastStates(taskId: string): void {
	const push = getPushMessage();
	if (!push) return;
	const m = registry.get(taskId);
	const states = m ? Array.from(m.values()) : [];
	push("scriptStateChanged", { taskId, states });
}

export async function getScriptStates(taskId: string, socket: string): Promise<ScriptState[]> {
	await refreshTaskStates(taskId, socket);
	const m = registry.get(taskId);
	return m ? Array.from(m.values()) : [];
}

export function getCachedScriptStates(taskId: string): ScriptState[] {
	const m = registry.get(taskId);
	return m ? Array.from(m.values()) : [];
}

function placementToSplitArgs(placement: ScriptPlacement): { kind: "split" | "window"; args: string[] } {
	switch (placement) {
		case "left":
			return { kind: "split", args: ["split-window", "-h", "-b"] };
		case "right":
			return { kind: "split", args: ["split-window", "-h"] };
		case "top":
			return { kind: "split", args: ["split-window", "-v", "-b"] };
		case "bottom":
			return { kind: "split", args: ["split-window", "-v"] };
		case "window":
			return { kind: "window", args: ["new-window"] };
	}
}

interface RunScriptOptions {
	taskId: string;
	worktreePath: string;
	scriptName: string;
	runner: ScriptRunner;
	placement: ScriptPlacement;
	socket?: string;
}

export async function runScript(opts: RunScriptOptions): Promise<ScriptState> {
	const { taskId, worktreePath, scriptName, runner, placement } = opts;
	const socket = opts.socket ?? pty.DEFAULT_TMUX_SOCKET;
	const session = taskSessionName(taskId);
	const command = resolveRunnerCommand(runner, scriptName);
	const taskMap = getOrCreateTaskMap(taskId);

	await refreshTaskStates(taskId, socket);

	const existing = taskMap.get(scriptName);

	// Already running with live pane → focus only, no relaunch.
	if (existing && existing.status === "running" && existing.paneId) {
		await focusPane(socket, existing.paneId);
		broadcastStates(taskId);
		return existing;
	}

	// Pane exists but exited (rare in V1 since we lack exit detection); rerun via send-keys.
	if (existing && existing.paneId && (await paneExists(socket, existing.paneId))) {
		await sendKeysToPane(socket, existing.paneId, command);
		await focusPane(socket, existing.paneId);
		const updated: ScriptState = {
			...existing,
			status: "running",
			startedAt: new Date().toISOString(),
			exitedAt: undefined,
			exitCode: undefined,
			placement,
		};
		taskMap.set(scriptName, updated);
		broadcastStates(taskId);
		return updated;
	}

	// Fresh launch: open a new pane / window.
	const { kind, args } = placementToSplitArgs(placement);
	const tmuxArgs =
		kind === "split"
			? pty.tmuxArgs(
				socket,
				...args,
				"-t",
				`${session}:`,
				"-c",
				worktreePath,
				"-P",
				"-F",
				"#{pane_id}",
				command,
			)
			: pty.tmuxArgs(
				socket,
				...args,
				"-t",
				`${session}:`,
				"-c",
				worktreePath,
				"-n",
				`script:${scriptName}`.slice(0, 20),
				"-P",
				"-F",
				"#{pane_id}",
				command,
			);

	const proc = spawn(tmuxArgs, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) {
		log.error("runScript tmux failed", {
			taskId: taskId.slice(0, 8),
			scriptName,
			placement,
			stderr: stderr.trim(),
		});
		throw new Error(`tmux ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
	}
	const paneId = stdout.trim();
	if (paneId) {
		// Best-effort: set pane title so user can see what's running.
		spawn(pty.tmuxArgs(socket, "select-pane", "-t", paneId, "-T", `script:${scriptName}`), {
			stdout: "pipe",
			stderr: "pipe",
		}).exited.catch(() => {});
	}
	const state: ScriptState = {
		taskId,
		scriptName,
		command,
		runner,
		placement,
		paneId: paneId || null,
		status: "running",
		startedAt: new Date().toISOString(),
	};
	taskMap.set(scriptName, state);
	broadcastStates(taskId);
	return state;
}

async function focusPane(socket: string, paneId: string): Promise<void> {
	spawn(pty.tmuxArgs(socket, "select-pane", "-t", paneId), {
		stdout: "pipe",
		stderr: "pipe",
	}).exited.catch(() => {});
}

async function sendKeysToPane(socket: string, paneId: string, command: string): Promise<void> {
	const proc = spawn(
		pty.tmuxArgs(socket, "send-keys", "-t", paneId, command, "Enter"),
		{ stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
}

export async function stopScript(taskId: string, scriptName: string, socket: string): Promise<void> {
	const state = registry.get(taskId)?.get(scriptName);
	if (!state || !state.paneId) return;
	const pid = await panePid(socket, state.paneId);
	if (!pid) return;
	try {
		process.kill(pid, "SIGINT");
		log.info("Sent SIGINT", { taskId: taskId.slice(0, 8), scriptName, pid });
	} catch (err) {
		log.warn("SIGINT failed", { taskId: taskId.slice(0, 8), pid, error: String(err) });
	}
	// Escalate to SIGTERM after 5s if still alive.
	setTimeout(() => {
		try {
			process.kill(pid, 0);
			process.kill(pid, "SIGTERM");
			log.info("Escalated to SIGTERM", { taskId: taskId.slice(0, 8), scriptName, pid });
		} catch {
			/* already dead */
		}
	}, 5000).unref?.();
	await refreshTaskStates(taskId, socket);
	broadcastStates(taskId);
}

export async function killScriptPane(taskId: string, scriptName: string, socket: string): Promise<void> {
	const m = registry.get(taskId);
	const state = m?.get(scriptName);
	if (!state || !state.paneId) return;
	const proc = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", state.paneId), {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	m?.delete(scriptName);
	broadcastStates(taskId);
}

export async function focusScriptPane(taskId: string, scriptName: string, socket: string): Promise<void> {
	const state = registry.get(taskId)?.get(scriptName);
	if (!state || !state.paneId) return;
	await focusPane(socket, state.paneId);
}

export function cleanupTaskScripts(taskId: string): void {
	registry.delete(taskId);
}

/**
 * Register an externally-managed entry in the script registry.
 * Used by Dev Server to expose itself in the unified Scripts panel.
 */
export function registerExternalScript(params: {
	taskId: string;
	scriptName: string;
	displayName: string;
	command: string;
	paneId: string;
}): void {
	const m = getOrCreateTaskMap(params.taskId);
	m.set(params.scriptName, {
		taskId: params.taskId,
		scriptName: params.scriptName,
		displayName: params.displayName,
		command: params.command,
		runner: "npm",
		placement: "right",
		paneId: params.paneId,
		status: "running",
		startedAt: new Date().toISOString(),
		external: true,
	});
	broadcastStates(params.taskId);
}

export function unregisterExternalScript(taskId: string, scriptName: string): void {
	const m = registry.get(taskId);
	if (!m) return;
	if (m.delete(scriptName)) {
		broadcastStates(taskId);
	}
}

/**
 * Returns the effective placement for a script:
 *   override → default → null
 */
export function resolveEffectivePlacement(task: Task, scriptName: string): ScriptPlacement | null {
	const prefs = task.scriptPlacement;
	if (!prefs) return null;
	if (prefs.overrides && prefs.overrides[scriptName]) return prefs.overrides[scriptName];
	if (prefs.default) return prefs.default;
	return null;
}

export function pickPlacementForLaunch(
	task: Task,
	scriptName: string,
	explicit: ScriptPlacement | undefined,
): { placement: ScriptPlacement; needsPicker: boolean } {
	if (explicit) return { placement: explicit, needsPicker: false };
	const eff = resolveEffectivePlacement(task, scriptName);
	if (eff) return { placement: eff, needsPicker: false };
	return { placement: "right", needsPicker: true };
}

// re-export for ergonomic imports
export { resolveRunnerCommand };
export type { PackageScripts };
