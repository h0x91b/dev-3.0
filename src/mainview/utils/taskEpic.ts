import type { Epic, Task } from "../../shared/types";
import { resolveEpicRef } from "../../shared/types";
import { facetToken } from "./taskSearch";

/** The task's epic as the search engine needs it; null for none or an epic no longer in the registry. */
export function epicOf(task: Pick<Task, "epicId">, epicsById: ReadonlyMap<string, Epic>): { id: string; name: string } | null {
	if (!task.epicId) return null;
	const epic = epicsById.get(task.epicId);
	return epic ? { id: epic.id, name: epic.name } : null;
}

/** `epic:"Payments v2"` — the token a chip click puts into the board filter. */
export function epicFilterToken(epic: Pick<Epic, "name">): string {
	return facetToken("epic", epic.name);
}

/** Replace any `epic:` token in the query with `token`, keeping the rest. */
export function withEpicToken(query: string, token: string): string {
	const rest = query
		.replace(/(^|\s)epic:(?:"(?:\\.|[^"\\])*"|\S+)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return rest ? `${rest} ${token}` : token;
}

/** The epic an `epic:` value names, or null when it names none (a typo matches nothing). */
export function epicForFilterValue(value: string, epics: readonly Epic[]): Epic | null {
	const result = resolveEpicRef(epics, value);
	return result.kind === "found" ? result.epic : null;
}
