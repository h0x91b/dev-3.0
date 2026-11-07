import type { TFunction } from "../i18n";
import { classifyPreparationFailure } from "../../shared/preparation-failure";

/** A preparation error in the user's language when it is a known kind; otherwise the text as sent. */
export function preparationFailureMessage(errorText: string, t: TFunction): string {
	const failure = classifyPreparationFailure(errorText);
	if (failure.kind === "unknown") return errorText;
	const message = t("task.startBranchMissing", { branch: failure.branch });
	return failure.rest ? `${message}\n${failure.rest}` : message;
}
