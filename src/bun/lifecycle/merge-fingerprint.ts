import type { Task } from "../../shared/types";
import * as git from "../git";
import type { MergeCompletionFingerprint } from "./merge-prompt";

/**
 * Identity of "this exact merged head", used to decide whether a merge-completion
 * prompt for it was already answered. Lives apart from the pollers so the
 * lifecycle executor can reuse it without importing the activity module.
 */
export async function getMergeCompletionFingerprint(
	task: Pick<Task, "id" | "worktreePath" | "branchName">,
	branchName: string | null,
): Promise<MergeCompletionFingerprint> {
	const resolvedBranchName = branchName || task.branchName || task.id;
	if (task.worktreePath) {
		const headSha = await git.getHeadSha(task.worktreePath);
		if (headSha) {
			return {
				fingerprint: `v1:${resolvedBranchName}:${headSha}`,
				precise: true,
			};
		}
	}
	return {
		fingerprint: `fallback:${resolvedBranchName}`,
		precise: false,
	};
}
