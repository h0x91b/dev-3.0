/** The on-disk shape of one board's persisted filter (`board-filters.json`): only its status tokens. */

export interface BoardFilterState {
	statuses: string[];
}

const MAX_STATUSES = 100;
const MAX_STATUS_LENGTH = 200;

export function normalizeBoardFilterState(raw: unknown): BoardFilterState {
	const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { statuses?: unknown }).statuses)
		? (raw as { statuses: unknown[] }).statuses
		: [];
	const statuses = new Set<string>();
	for (const entry of list) {
		if (typeof entry !== "string") continue;
		const value = entry.trim();
		if (value && value.length <= MAX_STATUS_LENGTH) statuses.add(value);
		if (statuses.size >= MAX_STATUSES) break;
	}
	return { statuses: [...statuses] };
}
