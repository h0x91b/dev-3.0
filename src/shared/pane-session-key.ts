/**
 * Composite WebSocket session key for native multi-pane terminals (seq 1311).
 *
 * A task's FIRST pane uses the bare `taskId` as its WS `?session=` key so that
 * every existing lifecycle path (ptyDied, capture, remote-proxy) keeps working
 * unchanged. Additional panes append `~<paneId>`, producing a stable key that
 * the renderer can build with the same function.
 *
 * `~` is chosen as the separator because it is URL-safe in a query value (RFC
 * 3986 §2.3 unreserved characters include `~`) and does not appear in task UUIDs
 * or pane ids (`pane-N`).
 */

const SEPARATOR = "~";

/**
 * Composite key for a non-first native pane.
 * The task's first pane keeps the bare `taskId`.
 */
export function paneSessionKey(taskId: string, paneId: string): string {
	return `${taskId}${SEPARATOR}${paneId}`;
}

export interface ParsedPaneSessionKey {
	taskId: string;
	paneId: string;
}

/**
 * Parse a composite key back into its parts.
 * Returns `null` for a bare task id (the first pane) or anything malformed.
 */
export function parsePaneSessionKey(key: string): ParsedPaneSessionKey | null {
	const idx = key.indexOf(SEPARATOR);
	if (idx < 1) return null;
	const taskId = key.slice(0, idx);
	const paneId = key.slice(idx + 1);
	if (!taskId || !paneId) return null;
	return { taskId, paneId };
}
