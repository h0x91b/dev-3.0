/**
 * In-memory state of `dev3 agent exit`, kept apart from the logic so the terminal
 * teardown paths (`pty-server.ts`, `handlePaneExited`) can drop it without importing
 * the whole exit machinery.
 */

import type { ScheduledMessageAuthor } from "../shared/types";

export type AgentTurnEvent = "Stop" | "UserPromptSubmit";

/** The last turn report of a pane's agent, with when it arrived. */
export interface TurnReport {
	event: AgentTurnEvent;
	at: number;
}

/** Which agent instance an exit was asked for; any later mismatch drops the exit. */
export interface ExitBinding {
	/** Full process identity where it can be proven. */
	author: ScheduledMessageAuthor | null;
	/** Fallback identity: the pane entry's conversation and the pane's root process. */
	sessionId: string | null;
	rootPid: number | null;
}

export interface PendingExit {
	projectId: string;
	taskId: string;
	paneId: string;
	self: boolean;
	binding: ExitBinding;
	/** When the CLI request started: a turn that ended after it already ended this call's turn. */
	requestedAt: number;
	/** `waiting` for a turn end, `settling` after one, `running` once the exit has begun. */
	phase: "waiting" | "settling" | "running";
	deadlineAt: number;
	deadlineTimer: ReturnType<typeof setTimeout>;
	settleTimer: ReturnType<typeof setTimeout> | null;
}

export const lastTurn = new Map<string, TurnReport>();
export const pending = new Map<string, PendingExit>();

export const exitKey = (taskId: string, paneId: string) => `${taskId}:${paneId}`;

function dropPending(key: string): void {
	const exit = pending.get(key);
	if (!exit) return;
	clearTimeout(exit.deadlineTimer);
	if (exit.settleTimer) clearTimeout(exit.settleTimer);
	pending.delete(key);
}

/** A pane that exited carries no idle state and no scheduled exit into whatever takes its id. */
export function forgetPaneExitState(taskId: string, paneId: string): void {
	const key = exitKey(taskId, paneId);
	lastTurn.delete(key);
	dropPending(key);
}

/** The task's terminal is torn down: every pane of it is gone. */
export function forgetTaskExitState(taskId: string): void {
	const prefix = `${taskId}:`;
	for (const key of [...lastTurn.keys(), ...pending.keys()]) {
		if (!key.startsWith(prefix)) continue;
		lastTurn.delete(key);
		dropPending(key);
	}
}

export function resetExtraAgentExitStateForTests(): void {
	for (const key of [...pending.keys()]) dropPending(key);
	lastTurn.clear();
}
