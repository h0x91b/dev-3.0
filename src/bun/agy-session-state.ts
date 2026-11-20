import { rmSync } from "node:fs";
import { agyStatuslineTaskDir } from "../shared/agy-statusline-state";
import { DEV3_HOME } from "./paths";

/** The agy sessions of a task that have a tool waiting for approval (the statusLine reports them). */
const pendingSessions = new Map<string, Set<string>>();

export function agyPendingSessionsOf(taskId: string): ReadonlySet<string> {
	return pendingSessions.get(taskId) ?? new Set();
}

export function addAgyPending(taskId: string, key: string): void {
	let waiting = pendingSessions.get(taskId);
	if (!waiting) pendingSessions.set(taskId, (waiting = new Set()));
	waiting.add(key);
}

/** Drop one session's wait; returns how many other sessions of the task still wait. */
export function removeAgyPending(taskId: string, key: string): number {
	const waiting = pendingSessions.get(taskId);
	waiting?.delete(key);
	if (waiting && waiting.size === 0) pendingSessions.delete(taskId);
	return waiting?.size ?? 0;
}

/**
 * Everything dev3 keeps about a task's agy panes: who waits for approval, and the per-pane
 * statusLine state `dev3 statusline agy` leaves on disk. Called when the task ends or its agent exits.
 */
export function forgetAgyTask(taskId: string, dev3Home: string = DEV3_HOME): void {
	pendingSessions.delete(taskId);
	const dir = agyStatuslineTaskDir(dev3Home, taskId);
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// the next run overwrites what is left
	}
}
