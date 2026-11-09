import type { ConfirmAlternativeAction, ConfirmOutcomeCards } from "../confirm";
import type { TFunction } from "../i18n";

const inFlightMergeCompletionPrompts = new Set<string>();

interface MergeCompletionDialogOptions {
	title: string;
	message: string;
	confirmLabel: string;
	cancelLabel: string;
	alternativeAction: ConfirmAlternativeAction;
	outcomeCards: ConfirmOutcomeCards;
	dismissOnBackdrop: false;
}

export function buildMergeCompletionDialogOptions(t: TFunction, branchName: string): MergeCompletionDialogOptions {
	return {
		title: t("app.branchMergedTitle"),
		message: t("app.branchMergedMessage"),
		confirmLabel: t("app.branchMergedComplete"),
		cancelLabel: t("app.branchMergedNotNow"),
		alternativeAction: { label: t("app.branchMergedManualCompletion"), value: "manual" },
		outcomeCards: {
			kicker: t("app.branchMergedKicker"),
			statusLabel: t("app.branchMergedStatus"),
			statusValue: branchName,
			confirmDescription: t("app.branchMergedCompleteDescription"),
			cancelDescription: t("app.branchMergedNotNowDescription"),
			alternativeDescription: t("app.branchMergedManualDescription"),
		},
		dismissOnBackdrop: false,
	};
}

function promptKey(taskId: string, fingerprint: string | null | undefined): string {
	return `${taskId}:${fingerprint || "unknown"}`;
}

export async function runMergeCompletionPromptOnce<T>(
	taskId: string,
	fingerprint: string | null | undefined,
	prompt: () => Promise<T>,
): Promise<T | null> {
	const key = promptKey(taskId, fingerprint);
	if (inFlightMergeCompletionPrompts.has(key)) return null;

	inFlightMergeCompletionPrompts.add(key);
	try {
		return await prompt();
	} finally {
		inFlightMergeCompletionPrompts.delete(key);
	}
}

export function _resetMergeCompletionPromptInFlightForTests(): void {
	inFlightMergeCompletionPrompts.clear();
}
