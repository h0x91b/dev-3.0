import type {
	ScriptPlacement,
	ScriptRunner,
	ScriptSource,
	WorktreeScripts,
} from "../../shared/types";
import {
	SCRIPT_PLACEMENTS,
	SCRIPT_RUNNERS,
	SCRIPT_SOURCES,
	scriptStorageKey,
} from "../../shared/types";
import * as data from "../data";
import { DEFAULT_TMUX_SOCKET } from "../tmux";
import { parsePackageScripts } from "../package-scripts";
import { parseMakefile } from "../makefile";
import { runScript as runScriptInTmux } from "../script-runner";
import { getPushMessage, log } from "./shared-pure";

async function parseRunnableScriptsHandler(params: {
	taskId: string;
	projectId: string;
}): Promise<WorktreeScripts> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return {
		package: parsePackageScripts(task.worktreePath),
		makefile: parseMakefile(task.worktreePath),
	};
}

function isValidPlacement(p: unknown): p is ScriptPlacement {
	return typeof p === "string" && (SCRIPT_PLACEMENTS as readonly string[]).includes(p);
}

function isValidRunner(r: unknown): r is ScriptRunner {
	return typeof r === "string" && (SCRIPT_RUNNERS as readonly string[]).includes(r);
}

function isValidSource(s: unknown): s is ScriptSource {
	return typeof s === "string" && (SCRIPT_SOURCES as readonly string[]).includes(s);
}

async function runScriptHandler(params: {
	taskId: string;
	projectId: string;
	scriptName: string;
	placement: ScriptPlacement;
	source: ScriptSource;
	runner?: ScriptRunner;
}): Promise<{ ok: true }> {
	const source: ScriptSource = isValidSource(params.source) ? params.source : "package";
	log.info("→ runScript", {
		taskId: params.taskId.slice(0, 8),
		scriptName: params.scriptName,
		source,
		placement: params.placement,
	});
	if (!isValidPlacement(params.placement)) {
		throw new Error(`invalid placement: ${params.placement}`);
	}
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) throw new Error("Task has no worktree");

	let runner: ScriptRunner = "npm";
	if (source === "make") {
		const mk = parseMakefile(task.worktreePath);
		if (!mk.targets.some((t) => t.name === params.scriptName)) {
			throw new Error(`Make target not found: ${params.scriptName}`);
		}
	} else {
		const pkg = parsePackageScripts(task.worktreePath);
		if (!pkg.scripts.some((s) => s.name === params.scriptName)) {
			throw new Error(`Script not found: ${params.scriptName}`);
		}
		runner = isValidRunner(params.runner) ? params.runner : pkg.runner;
	}

	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	await runScriptInTmux({
		taskId: task.id,
		worktreePath: task.worktreePath,
		scriptName: params.scriptName,
		source,
		runner,
		placement: params.placement,
		socket,
	});

	const storageKey = scriptStorageKey(source, params.scriptName);
	const { task: updated } = await data.updateTaskWith(project, task.id, (t) => ({
		updates: {
			scriptLastRunAt: {
				...(t.scriptLastRunAt ?? {}),
				[storageKey]: new Date().toISOString(),
			},
			scriptLastPlacement: {
				...(t.scriptLastPlacement ?? {}),
				[storageKey]: params.placement,
			},
		},
		result: undefined,
	}));
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	return { ok: true };
}

export const scriptsHandlers = {
	parseRunnableScripts: parseRunnableScriptsHandler,
	runScript: runScriptHandler,
};
