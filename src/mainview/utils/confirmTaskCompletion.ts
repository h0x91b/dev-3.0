import { api } from "../rpc";
import { confirm } from "../confirm";
import { taskDialogInfo } from "./taskDialogInfo";
import type { Task, Project, TaskStatus } from "../../shared/types";
import type { TFunction } from "../i18n";

/**
 * Checks git state before allowing a task to move to completed/cancelled.
 * Returns true if the move should proceed, false if the user cancelled.
 *
 * `alwaysConfirm` makes the dialog unconditional — for one-click affordances
 * (the card's quick-complete ✓) where a mis-click would otherwise complete a
 * clean task with no dialog at all. Git warnings, when present, ride in the
 * SAME dialog so the user never answers two prompts for one click.
 */
export async function confirmTaskCompletion(
	task: Task,
	project: Project,
	newStatus: TaskStatus,
	t: TFunction,
	onOpenTask?: () => void,
	options?: { alwaysConfirm?: boolean },
): Promise<boolean> {
	if (newStatus !== "completed" && newStatus !== "cancelled") return true;
	const alwaysConfirm = options?.alwaysConfirm ?? false;
	// PR-review tasks check out someone else's existing branch — the commits,
	// unpushed and unmerged state aren't the user's work, so completing them
	// must not warn about uncommitted/unpushed/unmerged changes.
	const skipGitCheck = !task.worktreePath || Boolean(task.existingBranch);
	if (skipGitCheck && !alwaysConfirm) return true;

	let status;
	if (!skipGitCheck) {
		try {
			status = await api.request.getBranchStatus({
				taskId: task.id,
				projectId: project.id,
			});
		} catch {
			// Can't check — don't block the move
			if (!alwaysConfirm) return true;
		}
	}

	const warnings: string[] = [];
	if (status) {
		// Uncommitted changes
		if (status.insertions > 0 || status.deletions > 0) {
			warnings.push(
				t("task.warnUncommitted", {
					insertions: String(status.insertions),
					deletions: String(status.deletions),
				}),
			);
		}

		// Unpushed commits (never pushed or local-only)
		if (status.unpushed === -1) {
			if (status.ahead > 0) {
				warnings.push(t("task.warnNeverPushed", { count: String(status.ahead) }));
			}
		} else if (status.unpushed > 0) {
			warnings.push(t("task.warnUnpushed", { count: String(status.unpushed) }));
		}

		// Pushed but unmerged (skip if content is already in base branch, e.g. squash/rebase merge)
		if (status.unpushed >= 0 && status.ahead > 0 && !status.mergedByContent) {
			warnings.push(
				t("task.warnUnmerged", {
					count: String(status.ahead),
					branch: task.baseBranch || project.defaultBaseBranch || "main",
				}),
			);
		}
	}

	if (warnings.length === 0 && !alwaysConfirm) return true;

	// Git trouble headlines the dialog when there is any; otherwise it is a plain
	// "you clicked the one-click control, confirm it" gate.
	const tail = task.worktreePath
		? t("task.warnCompletionFooter")
		: t(newStatus === "completed" ? "task.confirmCompleteFooter" : "task.confirmCancelFooter");

	return confirm({
		title: warnings.length > 0
			? t("task.warnCompletionTitle")
			: t(newStatus === "completed" ? "task.confirmCompleteTitle" : "task.confirmCancelTitle"),
		info: taskDialogInfo(task, project, onOpenTask),
		message: warnings.length > 0
			? `${warnings.map((w) => `• ${w}`).join("\n")}\n\n${tail}`
			: tail,
	});
}
