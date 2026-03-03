import { api } from "../rpc";
import type { Task, Project, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES } from "../../shared/types";
import type { TFunction } from "../i18n";

/**
 * Checks git state before allowing a task to move to completed/cancelled.
 * Returns true if the move should proceed, false if the user cancelled.
 */
export async function confirmTaskCompletion(
	task: Task,
	project: Project,
	newStatus: TaskStatus,
	t: TFunction,
): Promise<boolean> {
	if (!ACTIVE_STATUSES.includes(task.status)) return true;
	if (newStatus !== "completed" && newStatus !== "cancelled") return true;
	if (!task.worktreePath) return true;

	let status;
	try {
		status = await api.request.getBranchStatus({
			taskId: task.id,
			projectId: project.id,
		});
	} catch {
		// Can't check — don't block the move
		return true;
	}

	const warnings: string[] = [];

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

	if (warnings.length === 0) return true;

	const message =
		warnings.map((w) => `• ${w}`).join("\n") +
		"\n\n" +
		t("task.warnCompletionFooter");

	return api.request.showConfirm({
		title: t("task.warnCompletionTitle"),
		message,
	});
}
