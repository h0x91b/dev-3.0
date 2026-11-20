import { rmSync } from "node:fs";
import { AGY_WAIT_STALE_MS, agyPaneKey, agyStatuslineStateFile, agyStatuslineTaskDir } from "../shared/agy-statusline-state";
import { forgetApprovalResumeStatus, forgetTaskApprovalResumeStatuses } from "./approval-resume-status";
import { DEV3_HOME } from "./paths";

/** The agy sessions of a task that have a tool waiting for approval, with when each was last heard of. */
const pendingSessions = new Map<string, Map<string, number>>();

/** The waits of a task that are still alive; ones not heard of within AGY_WAIT_STALE_MS are dropped. */
function livePending(taskId: string, now: number): Map<string, number> | undefined {
	const waiting = pendingSessions.get(taskId);
	if (!waiting) return undefined;
	for (const [key, lastSeen] of waiting) if (now - lastSeen > AGY_WAIT_STALE_MS) waiting.delete(key);
	if (waiting.size === 0) pendingSessions.delete(taskId);
	return waiting;
}

export function agyPendingSessionsOf(taskId: string, now: number = Date.now()): ReadonlySet<string> {
	return new Set(livePending(taskId, now)?.keys() ?? []);
}

/** Record a wait, or refresh the one already there (the heartbeat). */
export function addAgyPending(taskId: string, key: string, now: number = Date.now()): void {
	livePending(taskId, now);
	let waiting = pendingSessions.get(taskId);
	if (!waiting) pendingSessions.set(taskId, (waiting = new Map()));
	waiting.set(key, now);
}

/** Drop one session's wait; returns how many other sessions of the task still wait. */
export function removeAgyPending(taskId: string, key: string, now: number = Date.now()): number {
	const waiting = livePending(taskId, now);
	waiting?.delete(key);
	if (waiting && waiting.size === 0) pendingSessions.delete(taskId);
	return waiting?.size ?? 0;
}

/**
 * An agy pane's agent exited: drop only what belongs to that pane and its conversation (its wait,
 * the lane remembered for it, its statusLine state file). The task's other panes keep theirs.
 */
export function forgetAgyPane(
	taskId: string,
	pane: { paneId: string | null; conversationId: string | null },
	dev3Home: string = DEV3_HOME,
): void {
	for (const key of [pane.paneId, pane.conversationId]) if (key) removeAgyPending(taskId, key);
	if (pane.conversationId) forgetApprovalResumeStatus(`${taskId}:${pane.conversationId}`);
	const files = [
		pane.paneId ? agyStatuslineStateFile(dev3Home, taskId, agyPaneKey({ TMUX_PANE: pane.paneId }, null)) : null,
		pane.conversationId ? agyStatuslineStateFile(dev3Home, taskId, agyPaneKey({}, pane.conversationId)) : null,
	];
	for (const file of files) {
		if (!file) continue;
		try {
			rmSync(file, { force: true });
		} catch {
			// the next run overwrites what is left
		}
	}
}

/**
 * Everything dev3 keeps about a task's agy panes: who waits for approval, the lanes remembered
 * for those waits, and the per-pane statusLine state `dev3 statusline agy` leaves on disk. For task teardown only: one exiting
 * pane goes through `forgetAgyPane`.
 */
export function forgetAgyTask(taskId: string, dev3Home: string = DEV3_HOME): void {
	pendingSessions.delete(taskId);
	forgetTaskApprovalResumeStatuses(taskId);
	const dir = agyStatuslineTaskDir(dev3Home, taskId);
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// the next run overwrites what is left
	}
}
