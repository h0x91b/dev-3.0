import { api } from "../rpc";
import { confirm } from "../confirm";
import { taskDialogInfo } from "./taskDialogInfo";
import { unsavedWorkWarning } from "./confirmTaskCompletion";
import { isOpsWorktreeTask, taskResetConsent, taskUsesWorktree, type Project, type Task, type TaskResetConsent } from "../../shared/types";
import type { TFunction } from "../i18n";

/**
 * Ask before a reset to To Do. Always shown — even a clean branch loses its
 * session and its dev3 branch — and the local unsaved-work check streams in with
 * the confirm button gated until it settles. Resolves to the consent to send
 * (what the dialog showed), or null when the user kept the task as it is.
 */
export async function confirmTaskReset(
	task: Task,
	project: Project,
	t: TFunction,
	onOpenTask?: () => void,
): Promise<TaskResetConsent | null> {
	const consent = taskResetConsent(task);
	const keepsFolder = !taskUsesWorktree(project, task);
	const branch = task.branchName;
	const opsWorktree = isOpsWorktreeTask(task);
	const unsaved = task.worktreePath && ((!keepsFolder && !task.existingBranch) || opsWorktree)
		? api.request.getUnsavedWork({ taskId: task.id, projectId: project.id })
		: null;
	const approved = await confirm({
		title: t("task.confirmResetTitle"),
		message: opsWorktree
			? t("task.confirmResetMessageOpsWorktree", { branch: branch ?? "" })
			: keepsFolder
				? t("task.confirmResetMessageVirtual")
				: branch
					? t("task.confirmResetMessage", { branch })
					: t("task.confirmResetMessageNoBranch"),
		confirmLabel: t("task.confirmResetLabel"),
		cancelLabel: t("task.confirmResetCancel"),
		danger: true,
		tone: "danger",
		info: taskDialogInfo(task, project, onOpenTask),
		deferred: unsaved
			? {
				pending: t("task.checkingBranchState"),
				unknown: t("task.branchStateUnknown"),
				gateConfirm: true,
				promise: unsaved.then((status) => unsavedWorkWarning(status, t)),
			}
			: undefined,
	});
	return approved ? consent : null;
}
