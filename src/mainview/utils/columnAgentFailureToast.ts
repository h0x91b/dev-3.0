/**
 * Which localized sentence a failed column-agent launch gets (seq 1395).
 *
 * Two things vary independently, so the copy is picked from both:
 *  • whether the app RECOGNISED the failure (`reason`) — a recognised one is
 *    explained in the user's language and says what to do about it, while an
 *    unrecognised one can only quote the backend's English `error` as diagnostics;
 *  • whether the task was MOVED as a fallback (`movedTo`) — built-in AI Review
 *    parks it in Your Review, a custom column leaves it where it is.
 *
 * The `reason` code is the whole point: nothing here ever reads or matches the
 * `error` string, so backend wording can change without silently breaking the UI.
 */

import type { AppRPCSchema } from "../../shared/types";
import type { TranslationKey } from "../i18n/translations/en";

type ColumnAgentFailed = AppRPCSchema["bun"]["messages"]["columnAgentFailed"];

export interface ColumnAgentFailureCopy {
	key: TranslationKey;
	/** Interpolation values; `status` is already a localized column name. */
	params: Record<string, string>;
}

export function columnAgentFailureCopy(
	payload: Pick<ColumnAgentFailed, "columnName" | "error" | "movedTo" | "reason">,
	localizedStatus: (status: NonNullable<ColumnAgentFailed["movedTo"]>) => string,
): ColumnAgentFailureCopy {
	const { columnName, error, movedTo, reason } = payload;
	if (reason === "terminal-not-running") {
		return movedTo
			? { key: "kanban.columnAgentNoTerminalMoved", params: { columnName, status: localizedStatus(movedTo) } }
			: { key: "kanban.columnAgentNoTerminal", params: { columnName } };
	}
	return movedTo
		? { key: "kanban.columnAgentFailedMoved", params: { columnName, status: localizedStatus(movedTo), error } }
		: { key: "kanban.columnAgentFailed", params: { columnName, error } };
}
