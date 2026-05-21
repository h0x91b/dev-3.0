import type {
	PackageScripts,
	ScriptPlacement,
	ScriptRunner,
	ScriptState,
	ScriptPlacementPrefs,
	Task,
} from "../../shared/types";
import { SCRIPT_PLACEMENTS, SCRIPT_RUNNERS, DEV_SERVER_SCRIPT_NAME } from "../../shared/types";
import * as data from "../data";
import * as pty from "../pty-server";
import { parsePackageScripts } from "../package-scripts";
import {
	runScript as runScriptInRegistry,
	stopScript as stopScriptInRegistry,
	killScriptPane as killScriptPaneInRegistry,
	focusScriptPane as focusScriptPaneInRegistry,
	getScriptStates as getScriptStatesInRegistry,
	getCachedScriptStates,
} from "../script-runner";
import { stopDevServer, killDevServerSession } from "./tmux-pty";
import { log } from "./shared-pure";

async function parsePackageScriptsHandler(params: {
	taskId: string;
	projectId: string;
}): Promise<PackageScripts> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return parsePackageScripts(task.worktreePath);
}

async function getScriptStatesHandler(params: { taskId: string }): Promise<ScriptState[]> {
	const task = await findTaskSomehow(params.taskId);
	const socket = task?.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	return getScriptStatesInRegistry(params.taskId, socket);
}

function isValidPlacement(p: unknown): p is ScriptPlacement {
	return typeof p === "string" && (SCRIPT_PLACEMENTS as readonly string[]).includes(p);
}

function isValidRunner(r: unknown): r is ScriptRunner {
	return typeof r === "string" && (SCRIPT_RUNNERS as readonly string[]).includes(r);
}

async function runScriptHandler(params: {
	taskId: string;
	projectId: string;
	scriptName: string;
	placement?: ScriptPlacement;
	runner?: ScriptRunner;
}): Promise<ScriptState> {
	log.info("→ runScript", { taskId: params.taskId.slice(0, 8), scriptName: params.scriptName, placement: params.placement });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) throw new Error("Task has no worktree");
	const pkg = parsePackageScripts(task.worktreePath);
	const entry = pkg.scripts.find((s) => s.name === params.scriptName);
	if (!entry) throw new Error(`Script not found: ${params.scriptName}`);

	const runner: ScriptRunner = isValidRunner(params.runner) ? params.runner : pkg.runner;
	const placement: ScriptPlacement = isValidPlacement(params.placement)
		? params.placement
		: (task.scriptPlacement?.overrides?.[params.scriptName] ?? task.scriptPlacement?.default ?? "right");

	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	const state = await runScriptInRegistry({
		taskId: task.id,
		worktreePath: task.worktreePath,
		scriptName: params.scriptName,
		runner,
		placement,
		socket,
	});

	// Persist placement memory: set default if missing, otherwise script override (only if user picked something different).
	const prefs: ScriptPlacementPrefs = { ...(task.scriptPlacement ?? {}) };
	let changed = false;
	if (!prefs.default) {
		prefs.default = placement;
		changed = true;
	} else if (placement !== prefs.default) {
		prefs.overrides = { ...(prefs.overrides ?? {}), [params.scriptName]: placement };
		changed = true;
	}
	if (changed) {
		await data.updateTask(project, task.id, { scriptPlacement: prefs });
	}
	return state;
}

function findExternalState(taskId: string, scriptName: string): ScriptState | undefined {
	const cached = getCachedScriptStates(taskId);
	return cached.find((s) => s.scriptName === scriptName && s.external);
}

async function stopScriptHandler(params: { taskId: string; scriptName: string }): Promise<{ ok: true }> {
	if (params.scriptName === DEV_SERVER_SCRIPT_NAME || findExternalState(params.taskId, params.scriptName)) {
		const task = await findTaskSomehow(params.taskId);
		if (task) {
			await stopDevServer({ taskId: task.id, projectId: task.projectId });
		}
		return { ok: true };
	}
	const task = await findTaskSomehow(params.taskId);
	const socket = task?.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await stopScriptInRegistry(params.taskId, params.scriptName, socket);
	return { ok: true };
}

async function killScriptPaneHandler(params: { taskId: string; scriptName: string }): Promise<{ ok: true }> {
	if (params.scriptName === DEV_SERVER_SCRIPT_NAME || findExternalState(params.taskId, params.scriptName)) {
		const task = await findTaskSomehow(params.taskId);
		const socket = task?.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killDevServerSession(params.taskId, socket);
		return { ok: true };
	}
	const task = await findTaskSomehow(params.taskId);
	const socket = task?.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await killScriptPaneInRegistry(params.taskId, params.scriptName, socket);
	return { ok: true };
}

async function focusScriptPaneHandler(params: { taskId: string; scriptName: string }): Promise<{ ok: true }> {
	const task = await findTaskSomehow(params.taskId);
	const socket = task?.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await focusScriptPaneInRegistry(params.taskId, params.scriptName, socket);
	return { ok: true };
}

async function setTaskScriptPlacementHandler(params: {
	taskId: string;
	projectId: string;
	default?: ScriptPlacement | null;
	override?: { scriptName: string; placement: ScriptPlacement | null };
}): Promise<Task> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const prefs: ScriptPlacementPrefs = { ...(task.scriptPlacement ?? {}) };
	if (params.default !== undefined) {
		if (params.default === null) {
			delete prefs.default;
		} else if (isValidPlacement(params.default)) {
			prefs.default = params.default;
		}
	}
	if (params.override) {
		const overrides = { ...(prefs.overrides ?? {}) };
		if (params.override.placement === null) {
			delete overrides[params.override.scriptName];
		} else if (isValidPlacement(params.override.placement)) {
			overrides[params.override.scriptName] = params.override.placement;
		}
		prefs.overrides = overrides;
	}
	return data.updateTask(project, task.id, { scriptPlacement: prefs });
}

async function findTaskSomehow(taskId: string): Promise<Task | null> {
	const projects = await data.loadProjects();
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const task = tasks.find((t) => t.id === taskId);
		if (task) return task;
	}
	return null;
}

export const scriptsHandlers = {
	parsePackageScripts: parsePackageScriptsHandler,
	getScriptStates: getScriptStatesHandler,
	runScript: runScriptHandler,
	stopScript: stopScriptHandler,
	killScriptPane: killScriptPaneHandler,
	focusScriptPane: focusScriptPaneHandler,
	setTaskScriptPlacement: setTaskScriptPlacementHandler,
};
