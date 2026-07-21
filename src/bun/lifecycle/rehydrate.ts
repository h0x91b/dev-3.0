import { existsSync } from "node:fs";
import type { Project, Task } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { DEFAULT_TMUX_SOCKET } from "../tmux";
import { log } from "../rpc-handlers/shared";
import { dispatchLifecycleEvent } from "./service";

function shouldRehydrate(task: Task): boolean {
	return !!task.runtimeState
		|| task.preparing === true
		|| (!!task.worktreePath && task.status !== "completed" && task.status !== "cancelled");
}

function expectedWorktreePath(project: Project, task: Task): string | null {
	if (task.worktreePath) return task.worktreePath;
	if (!task.preparing && task.runtimeState?.runtime !== "preparing") return null;
	if (project.kind === "virtual") {
		return task.opsWorkDir?.trim() || git.virtualWorkDir(project, task);
	}
	return `${git.taskDir(project, task)}/worktree`;
}

async function rehydrateTask(project: Project, task: Task): Promise<void> {
	const worktreePath = expectedWorktreePath(project, task);
	const [tmuxAlive] = await Promise.all([
		pty.tmuxSessionExists(task.id, task.tmuxSocket ?? DEFAULT_TMUX_SOCKET),
	]);
	await dispatchLifecycleEvent(project.id, task.id, {
		type: "bootObserved",
		reality: {
			worktreeExists: worktreePath ? existsSync(worktreePath) : false,
			tmuxAlive,
		},
	}, { project, task });
}

export async function rehydrateTaskLifecycles(): Promise<void> {
	const projects = [
		...await data.loadProjects(),
		...await data.loadVirtualProjects(),
	];
	const work: Promise<void>[] = [];
	for (const project of projects) {
		for (const task of await data.loadTasks(project)) {
			if (!shouldRehydrate(task)) continue;
			work.push(rehydrateTask(project, task).catch((error) => {
				log.warn("Lifecycle boot rehydration failed", {
					projectId: project.id.slice(0, 8),
					taskId: task.id.slice(0, 8),
					error: String(error),
				});
			}));
		}
	}
	await Promise.all(work);
}
