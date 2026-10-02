import { hasGitWorkflow, type Project, type Task } from "../shared/types";
import { virtualWorkDir } from "./git";

/**
 * Where a task without a worktree runs: an Operations task's own folder, or the
 * project folder itself when the project's git workflow is off. Null for a task
 * that gets a worktree.
 */
export function folderWorkDir(project: Project, task: Task): string | null {
	if (project.kind === "virtual") return task.opsWorkDir?.trim() || virtualWorkDir(project, task);
	return hasGitWorkflow(project) ? null : project.path;
}
