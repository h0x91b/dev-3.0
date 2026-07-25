import { existsSync } from "node:fs";
import type { Project, Task } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { DEFAULT_TMUX_SOCKET } from "../tmux";
import { log } from "../rpc-handlers/shared";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";
import { nativeTaskTerminalAlive } from "../native-task-terminal";
import { dispatchLifecycleEvent } from "./service";

function shouldRehydrate(task: Task): boolean {
	return (!!task.runtimeState && task.runtimeState.runtime !== "idle")
		|| task.preparing === true
		|| (!!task.worktreePath && task.status !== "completed" && task.status !== "cancelled");
}

function expectedWorktreePath(project: Project, task: Task): string | null {
	if (task.worktreePath) return task.worktreePath;
	if (
		!task.preparing
		&& task.runtimeState?.runtime !== "preparing"
		&& task.runtimeState?.runtime !== "tearing-down"
	) return null;
	if (project.kind === "virtual") {
		return task.opsWorkDir?.trim() || git.virtualWorkDir(project, task);
	}
	return `${git.taskDir(project, task)}/worktree`;
}

/**
 * Is this task's terminal still live, on ITS backend?
 *
 * A native task must never be probed through tmux — a tmux `has-session` for it
 * would always answer "no" and the lifecycle machine would declare a perfectly
 * healthy host dead. Both branches only READ: the actual reattach happens when the
 * task is opened, so boot never binds a writer client (and never starts an idle
 * timer) for a session nobody is looking at.
 */
async function terminalStillAlive(task: Task): Promise<boolean> {
	if (taskTerminalBackendIdentity(task) === "tmux") {
		return pty.tmuxSessionExists(task.id, task.tmuxSocket ?? DEFAULT_TMUX_SOCKET);
	}
	try {
		return await nativeTaskTerminalAlive(task.id);
	} catch (error) {
		log.warn("Lifecycle boot native presence probe failed", {
			taskId: task.id.slice(0, 8),
			error: String(error),
		});
		return false;
	}
}

async function rehydrateTask(project: Project, task: Task): Promise<void> {
	const worktreePath = expectedWorktreePath(project, task);
	const worktreeExists = worktreePath ? existsSync(worktreePath) : false;
	const terminalAlive = await terminalStillAlive(task);
	let branchName = task.branchName ?? null;
	if (project.kind !== "virtual" && worktreeExists && worktreePath && !branchName) {
		try {
			branchName = await git.getCurrentBranch(worktreePath);
		} catch (error) {
			log.warn("Lifecycle boot branch probe failed", {
				taskId: task.id.slice(0, 8),
				error: String(error),
			});
		}
	}
	await dispatchLifecycleEvent(project.id, task.id, {
		type: "bootObserved",
		reality: {
			worktreeExists,
			terminalAlive,
			worktreePath: worktreeExists ? worktreePath : null,
			branchName,
		},
	}, { project, task });
}

function protectedWorktreePaths(project: Project, tasks: Task[]): Set<string> {
	const paths = new Set<string>();
	for (const task of tasks) {
		if (!shouldRehydrate(task)) continue;
		const path = expectedWorktreePath(project, task);
		if (path) paths.add(path);
	}
	return paths;
}

export async function rehydrateTaskLifecycles(): Promise<void> {
	const projects = [
		...await data.loadProjects(),
		...await data.loadVirtualProjects(),
	];
	const work: Promise<void>[] = [];
	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		if (project.kind !== "virtual") {
			try {
				await git.recoverStaleInitializingWorktrees(
					project,
					protectedWorktreePaths(project, tasks),
				);
			} catch (error) {
				log.warn("Lifecycle boot stale worktree recovery failed", {
					projectId: project.id.slice(0, 8),
					error: String(error),
				});
			}
		}
		for (const task of tasks) {
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
