import type {
	PackageScripts,
	ScriptPlacement,
	ScriptRunner,
} from "../../shared/types";
import { SCRIPT_PLACEMENTS, SCRIPT_RUNNERS } from "../../shared/types";
import * as data from "../data";
import * as pty from "../pty-server";
import { parsePackageScripts } from "../package-scripts";
import { runScript as runScriptInTmux } from "../script-runner";
import { log } from "./shared-pure";

async function parsePackageScriptsHandler(params: {
	taskId: string;
	projectId: string;
}): Promise<PackageScripts> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return parsePackageScripts(task.worktreePath);
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
	placement: ScriptPlacement;
	runner?: ScriptRunner;
}): Promise<{ ok: true }> {
	log.info("→ runScript", { taskId: params.taskId.slice(0, 8), scriptName: params.scriptName, placement: params.placement });
	if (!isValidPlacement(params.placement)) {
		throw new Error(`invalid placement: ${params.placement}`);
	}
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) throw new Error("Task has no worktree");
	const pkg = parsePackageScripts(task.worktreePath);
	const entry = pkg.scripts.find((s) => s.name === params.scriptName);
	if (!entry) throw new Error(`Script not found: ${params.scriptName}`);

	const runner: ScriptRunner = isValidRunner(params.runner) ? params.runner : pkg.runner;
	const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	await runScriptInTmux({
		taskId: task.id,
		worktreePath: task.worktreePath,
		scriptName: params.scriptName,
		runner,
		placement: params.placement,
		socket,
	});

	await data.updateTaskWith(project, task.id, (t) => ({
		updates: {
			scriptLastRunAt: {
				...(t.scriptLastRunAt ?? {}),
				[params.scriptName]: new Date().toISOString(),
			},
			scriptLastPlacement: {
				...(t.scriptLastPlacement ?? {}),
				[params.scriptName]: params.placement,
			},
		},
		result: undefined,
	}));
	return { ok: true };
}

export const scriptsHandlers = {
	parsePackageScripts: parsePackageScriptsHandler,
	runScript: runScriptHandler,
};
