import type { Project, Task } from "../shared/types";
import { isOpsWorktreeTask } from "../shared/types";
import * as repoConfig from "./repo-config";

/** Repo view of a worktree-mode task: `path` = attached repo. Never pass it to `data.*`. */
export function rootProjectFor(project: Project, task: Task): Project {
	return isOpsWorktreeTask(task) ? { ...project, path: task.attachedRepo! } : project;
}

/** Launch project: repo config for git and worktree-mode tasks; `path` stays the ops project's. */
export async function resolveLaunchProject(project: Project, task: Task, worktreePath: string): Promise<Project> {
	if (project.kind !== "virtual") return repoConfig.resolveProjectConfig(project, worktreePath);
	if (!isOpsWorktreeTask(task)) return project;
	const resolved = await repoConfig.resolveOperationalProjectConfig(rootProjectFor(project, task), worktreePath);
	return { ...resolved, path: project.path };
}
