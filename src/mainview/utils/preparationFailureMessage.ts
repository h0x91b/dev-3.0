import type { TFunction, TranslationKey } from "../i18n";
import { classifyPreparationFailure, type StartAfterAbandonReason } from "../../shared/preparation-failure";

const START_AFTER_KEYS: Record<StartAfterAbandonReason, TranslationKey> = {
	"gone": "task.startAfterGone",
	"cancelled": "task.startAfterCancelled",
	"no-pr": "task.startAfterNoPr",
	"pr-closed": "task.startAfterPrClosed",
};

/** A preparation error in the user's language when it is a known kind; otherwise the text as sent. */
export function preparationFailureMessage(errorText: string, t: TFunction): string {
	const failure = classifyPreparationFailure(errorText);
	if (failure.kind === "unknown") return errorText;
	if (failure.kind === "start-after-abandoned") return t(START_AFTER_KEYS[failure.reason], { seq: String(failure.seq) });
	const message = t("task.startBranchMissing", { branch: failure.branch });
	return failure.rest ? `${message}\n${failure.rest}` : message;
}

/**
 * The card's banner text. An abandoned start-after wait launched nothing, so it reads
 * "Did not start", never "Launch failed".
 */
export function preparationBannerText(errorText: string, t: TFunction): string {
	const message = preparationFailureMessage(errorText, t);
	return classifyPreparationFailure(errorText).kind === "start-after-abandoned"
		? message
		: t("task.launchFailed", { error: message });
}

/** True when the error is a kind the renderer explains, so its full text is worth showing unclipped. */
export function isKnownPreparationFailure(errorText: string | null | undefined): boolean {
	return classifyPreparationFailure(errorText).kind !== "unknown";
}
