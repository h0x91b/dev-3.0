import { taskUsesWorktree, type Project, type Task } from "../shared/types";
import { virtualWorkDir } from "./git";

/**
 * Where a task without a worktree runs: an Operations task's own folder, or the
 * project folder itself when the project's git workflow is off and the task did
 * not ask for a worktree of its own. Null for a task that gets a worktree.
 */
export function folderWorkDir(project: Project, task: Task): string | null {
	if (project.kind === "virtual") return task.opsWorkDir?.trim() || virtualWorkDir(project, task);
	return taskUsesWorktree(project, task) ? null : project.path;
}
