import type { Task } from "./types";

/**
 * The main agent's first launch ended before it created a conversation, and the
 * main pane still points at that launch's id (or at nothing): there is no
 * conversation to resume, only a fresh start.
 */
export function mainAgentNeverStarted(task: Pick<Task, "launchFailure" | "sessionState">): boolean {
	const failure = task.launchFailure;
	if (failure?.neverStarted !== true) return false;
	const stored = task.sessionState?.panes?.[0]?.sessionId;
	return !stored || stored === failure.sessionId;
}
