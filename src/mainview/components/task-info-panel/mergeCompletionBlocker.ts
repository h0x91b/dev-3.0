import { MERGE_COMPLETE_ELIGIBLE_STATUSES, type BranchStatus, type TaskStatus } from "../../../shared/types";
import { statusKey, type TranslationKey } from "../../i18n";

export type MergeCompletionBlocker = {
	key: TranslationKey;
	params?: Record<string, string | number>;
	/** A status key to translate and pass as {status}. */
	statusParam?: TranslationKey;
};

/**
 * Why the "Branch merged → complete the task?" offer cannot be made right now,
 * or null when it can. Each reason is distinct on purpose: one catch-all
 * "not merged yet" message used to claim a merged branch was unmerged.
 */
export function mergeCompletionBlocker(
	status: BranchStatus,
	{ compareRef, baseBranch, taskStatus }: { compareRef: string | null; baseBranch: string; taskStatus: TaskStatus },
): MergeCompletionBlocker | null {
	// mergedByContent is computed against whatever ref the user selected in the
	// compare dropdown; the prompt is only meaningful against the real base.
	const isDefaultBaseCompare =
		!compareRef || compareRef === baseBranch || compareRef === `origin/${baseBranch}`;
	if (!isDefaultBaseCompare) {
		return { key: "infoPanel.mergeCheckCompareRef", params: { ref: compareRef!, branch: baseBranch } };
	}
	// The popup claims "no changes left" — uncommitted changes mean that's false,
	// and completing would destroy them.
	if (status.insertions > 0 || status.deletions > 0) {
		return { key: "infoPanel.mergeCheckUncommitted" };
	}
	if (!status.mergedByContent) {
		return { key: "infoPanel.mergeCheckNotMerged", params: { branch: baseBranch } };
	}
	if (!MERGE_COMPLETE_ELIGIBLE_STATUSES.includes(taskStatus)) {
		return { key: "infoPanel.mergeCheckStatusIneligible", statusParam: statusKey(taskStatus) };
	}
	return null;
}
