/**
 * Which localized sentence a failed column-agent launch gets.
 *
 * Three things vary independently:
 *  • whether the app RECOGNISED the failure (`reason`) — a recognised one is
 *    explained in the user's language and says what to do about it, while an
 *    unrecognised one can only quote the backend's English `error` as diagnostics;
 *  • whether the task was MOVED as a fallback (`movedTo`) — the built-in AI Review
 *    column parks it in Your Review, a custom column leaves it where it is;
 *  • whose column it was — a built-in column is named by localizing its status,
 *    only a user-named custom column is shown literally.
 *
 * Nothing here reads or matches the `error` string, so backend wording can change
 * without silently breaking the UI.
 */

import type { AppRPCSchema, ColumnAgentIdentity, TaskStatus } from "../../shared/types";
import type { TranslationKey } from "../i18n/translations/en";

type ColumnAgentFailed = AppRPCSchema["bun"]["messages"]["columnAgentFailed"];

export interface ColumnAgentFailureCopy {
	key: TranslationKey;
	/** Interpolation values; `columnName` and `status` are already localized. */
	params: Record<string, string>;
}

/** The column's display name: localized for a built-in, literal for a custom one. */
export function columnAgentDisplayName(
	column: ColumnAgentIdentity,
	localizedStatus: (status: TaskStatus) => string,
): string {
	return column.kind === "builtin" ? localizedStatus(column.status) : column.name;
}

export function columnAgentFailureCopy(
	payload: Pick<ColumnAgentFailed, "column" | "error" | "movedTo" | "reason">,
	localizedStatus: (status: TaskStatus) => string,
): ColumnAgentFailureCopy {
	const { column, error, movedTo, reason } = payload;
	const columnName = columnAgentDisplayName(column, localizedStatus);
	// Unrecognised first: that is the only case allowed to quote the backend string.
	if (reason === undefined) {
		return movedTo
			? { key: "kanban.columnAgentFailedMoved", params: { columnName, status: localizedStatus(movedTo), error } }
			: { key: "kanban.columnAgentFailed", params: { columnName, error } };
	}
	// Exhaustive on purpose: a new recognised reason must not compile until it has
	// its own localized copy, instead of silently falling back to the raw error.
	switch (reason) {
		case "terminal-not-running":
			return movedTo
				? { key: "kanban.columnAgentNoTerminalMoved", params: { columnName, status: localizedStatus(movedTo) } }
				: { key: "kanban.columnAgentNoTerminal", params: { columnName } };
		default:
			return assertNever(reason);
	}
}

function assertNever(reason: never): never {
	throw new Error(`No localized copy for column-agent failure reason: ${String(reason)}`);
}
