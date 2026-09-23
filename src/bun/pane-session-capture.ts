import type { Task } from "../shared/types";

export type SessionPane = NonNullable<Task["sessionState"]>["panes"][number];

/**
 * Where a hook-reported session id belongs among the stored panes, as the new
 * pane list — or null when nothing changes or the match is ambiguous.
 * `mainEntry` is the entry to create when `panes` is empty (null: never create).
 */
export function placePaneSession(
	panes: SessionPane[],
	paneId: string,
	sessionId: string,
	mainEntry: SessionPane | null,
): SessionPane[] | null {
	if (!panes.length) return mainEntry ? [{ ...mainEntry, paneId, sessionId }] : null;
	let idx = panes.findIndex((pane) => pane.paneId === paneId);
	if (idx !== -1) {
		if (panes[idx].sessionId === sessionId) return null;
		return panes.map((pane, i) => (i === idx ? { ...pane, sessionId } : pane));
	}
	// The same conversation reporting from a pane nobody recorded was resumed
	// there; follow it, or pane-exit reconciliation drops it with the old pane.
	const moved = panes.flatMap((pane, i) => (pane.sessionId === sessionId ? [i] : []));
	if (moved.length === 1) idx = moved[0];
	else {
		const unassigned = panes.flatMap((pane, i) => (pane.paneId ? [] : [i]));
		if (unassigned.length !== 1) return null;
		idx = unassigned[0];
	}
	return panes.map((pane, i) => (i === idx ? { ...pane, paneId, sessionId } : pane));
}
