import { existsSync } from "node:fs";
import { type Project, type Task, resolveTaskCompareBaseBranch } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { createLogger } from "./logger";

const log = createLogger("task-branch-sync");

/**
 * A rename must not move the branch the task is compared against.
 * `resolveTaskCompareBaseBranch` recognises a review task's checkout ref by it
 * matching `branchName`; once the branch is renamed that match is gone and the
 * review branch leaks through as the comparison base, so every ahead/behind
 * number, the diff chip, and the rebase target start describing a foreign
 * branch. Freeze the pre-rename answer into `baseBranch` — but only when it
 * survives being stored, so renaming *onto* the base name changes nothing.
 */
function compareBasePin(project: Project, task: Task, liveBranch: string): { baseBranch?: string } {
	const before = resolveTaskCompareBaseBranch(task, project);
	const renamed = { ...task, branchName: liveBranch };
	if (resolveTaskCompareBaseBranch(renamed, project) === before) return {};
	if (resolveTaskCompareBaseBranch({ ...renamed, baseBranch: before }, project) !== before) return {};
	log.info("Branch renamed, pinning comparison base", { taskId: task.id.slice(0, 8), baseBranch: before });
	return { baseBranch: before };
}

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
		const updates: Partial<Task> = { branchName: liveBranch, ...compareBasePin(project, task, liveBranch) };
		const updated = await data.updateTask(project, task.id, updates);
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
