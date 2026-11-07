import { realpathSync } from "node:fs";
import type { Project, Task } from "../shared/types";
import { isOpsWorktreeTask } from "../shared/types";
import { OPS_DIR } from "./paths";
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

/**
 * Task work dirs under OPS_DIR are deleted with their task, so a repo inside one cannot be attached.
 * `git rev-parse --show-toplevel` resolves symlinks, so OPS_DIR is compared in both forms.
 */
export function isInsideOpsDir(path: string): boolean {
	let resolved = OPS_DIR;
	try { resolved = realpathSync(OPS_DIR); } catch { /* no ops dir yet: nothing can be inside it */ }
	return [OPS_DIR, resolved].some((root) => path === root || path.startsWith(`${root}/`));
}
