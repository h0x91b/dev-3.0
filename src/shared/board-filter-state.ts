/** The on-disk shape of one board's persisted state (`board-filters.json`): its Active | All visibility. */

export type TaskVisibility = "active" | "all";

export interface BoardFilterState {
	visibility: TaskVisibility;
}

export function normalizeBoardFilterState(raw: unknown): BoardFilterState {
	const visibility = typeof raw === "object" && raw !== null ? (raw as { visibility?: unknown }).visibility : undefined;
	return { visibility: visibility === "active" ? "active" : "all" };
}
