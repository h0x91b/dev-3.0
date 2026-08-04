import { api } from "../rpc";
import { confirm } from "../confirm";
import { taskDialogInfo } from "./taskDialogInfo";
import type { Task, Project, TaskStatus, BranchStatus, UnsavedWork } from "../../shared/types";
import type { TFunction } from "../i18n";

/**
 * Bullet list of everything that would be lost by deleting this worktree.
 * `mergedByContent`/`behind` only exist on the heavy {@link BranchStatus}; with
 * the local-only {@link UnsavedWork} the "pushed but unmerged" line is skipped,
 * because that work is already safe on the remote.
 */
function gitWarnings(status: BranchStatus | UnsavedWork, task: Task, project: Project, t: TFunction): string[] {
	const warnings: string[] = [];

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
			warnings.push(t.plural("task.warnNeverPushed", status.ahead));
		}
	} else if (status.unpushed > 0) {
		warnings.push(t.plural("task.warnUnpushed", status.unpushed));
	}

	// Pushed but unmerged (skip if content is already in base branch, e.g. squash/rebase merge)
	if ("mergedByContent" in status && status.unpushed >= 0 && status.ahead > 0 && !status.mergedByContent) {
		warnings.push(
			t.plural("task.warnUnmerged", status.ahead, { branch: task.baseBranch || project.defaultBaseBranch || "main" }),
		);
	}

	return warnings;
}

/**
 * Checks git state before allowing a task to move to completed/cancelled.
 * Returns true if the move should proceed, false if the user cancelled.
 *
 * `alwaysConfirm` makes the dialog unconditional — for one-click affordances
 * (the card's quick-complete ✓) where a mis-click would otherwise complete a
 * clean task with no dialog at all. That path renders the dialog IMMEDIATELY and
 * streams the check into it, and asks the local-only `getUnsavedWork` rather
 * than `getBranchStatus` (three `git fetch` calls + `gh pr list` + a shared
 * semaphore ⇒ seconds). The confirm button stays gated until the check settles,
 * which is imperceptible for local git, so the warnings cannot be clicked past.
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

	const tail = task.worktreePath
		? t("task.warnCompletionFooter")
		: t(newStatus === "completed" ? "task.confirmCompleteFooter" : "task.confirmCancelFooter");
	const info = taskDialogInfo(task, project, onOpenTask);

	// One-click path: on screen now, local git check streamed in.
	if (alwaysConfirm) {
		const unsaved = skipGitCheck
			? null
			: api.request.getUnsavedWork({ taskId: task.id, projectId: project.id });
		return confirm({
			title: t(newStatus === "completed" ? "task.confirmCompleteTitle" : "task.confirmCancelTitle"),
			confirmLabel: t(newStatus === "completed" ? "task.confirmCompleteLabel" : "task.confirmCancelLabel"),
			info,
			message: tail,
			deferred: unsaved
				? {
					pending: t("task.checkingBranchState"),
					unknown: t("task.branchStateUnknown"),
					gateConfirm: true,
					promise: unsaved.then((status) => {
						const warnings = gitWarnings(status, task, project, t);
						return warnings.length > 0 ? warnings.map((w) => `• ${w}`).join("\n") : null;
					}),
				}
				: undefined,
		});
	}

	// Menu path: unchanged — full remote-aware status, and only ever prompts when
	// there is something to warn about.
	let status;
	try {
		status = await api.request.getBranchStatus({ taskId: task.id, projectId: project.id });
	} catch {
		// Can't check — don't block the move
		return true;
	}
	if (!status) return true;

	const warnings = gitWarnings(status, task, project, t);
	if (warnings.length === 0) return true;

	return confirm({
		title: t("task.warnCompletionTitle"),
		confirmLabel: t(newStatus === "completed" ? "task.confirmCompleteLabel" : "task.confirmCancelLabel"),
		info,
		message: `${warnings.map((w) => `• ${w}`).join("\n")}\n\n${tail}`,
	});
}
