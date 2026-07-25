import { existsSync } from "node:fs";
import type { Project, Task } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { createLogger } from "./logger";

const log = createLogger("task-branch-sync");

/**
 * Reconcile `task.branchName` with the branch actually checked out in the
 * worktree. Agents rename branches out of band (`git branch -m`), and the stored
 * name is what `dev3 current`, the task header, and PR flows display — without
 * this it stays stale until the renderer's next branch-status poll.
 */
export async function syncTaskBranchName(project: Project, task: Task): Promise<Task> {
	if (project.kind === "virtual") return task;
	if (!task.worktreePath || !existsSync(task.worktreePath)) return task;

	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	if (!liveBranch || liveBranch === task.branchName) return task;

	try {
		const updated = await data.updateTask(project, task.id, { branchName: liveBranch });
		// Persisting alone leaves the renderer's in-memory task stale (it only
		// refreshes on a taskUpdated push), so broadcast the new name too.
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("Branch renamed, synced stored name", { old: task.branchName, new: liveBranch });
		return updated;
	} catch (err) {
		log.warn("Failed to sync renamed branch name", { taskId: task.id.slice(0, 8), error: String(err) });
		return task;
	}
}
