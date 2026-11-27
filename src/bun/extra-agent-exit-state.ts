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
	/** Set by a pane exit or a terminal teardown: a run in flight stops at its next check. */
	cancelled: boolean;
	/** The quit command went out: the pane leaving is the expected result, not a reason to stop. */
	typed: boolean;
	/** The pane is being closed: its own exit is expected, but a task teardown still cancels. */
	closing: boolean;
	deadlineTimer: ReturnType<typeof setTimeout>;
	settleTimer: ReturnType<typeof setTimeout> | null;
}

export const lastTurn = new Map<string, TurnReport>();
export const pending = new Map<string, PendingExit>();

export const exitKey = (taskId: string, paneId: string) => `${taskId}:${paneId}`;

const paneGeneration = new Map<string, number>();
const taskGeneration = new Map<string, number>();
const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Changes whenever the pane's or its task's state was forgotten: a report judged before that is stale. */
export const stateGeneration = (taskId: string, paneId: string) => `${taskGeneration.get(taskId) ?? 0}.${paneGeneration.get(exitKey(taskId, paneId)) ?? 0}`;

function dropPending(key: string, cancelRunning: (exit: PendingExit) => boolean): void {
	const exit = pending.get(key);
	if (!exit) return;
	if (cancelRunning(exit)) exit.cancelled = true;
	clearTimeout(exit.deadlineTimer);
	if (exit.settleTimer) clearTimeout(exit.settleTimer);
	pending.delete(key);
}

/** A finished run leaves the table, timers included — unless a newer exit already took the key. */
export function finishPendingExit(exit: PendingExit): void {
	const key = exitKey(exit.taskId, exit.paneId);
	if (pending.get(key) === exit) dropPending(key, () => false);
}

/** A pane that exited carries no idle state and no scheduled exit into whatever takes its id. */
export function forgetPaneExitState(taskId: string, paneId: string): void {
	const key = exitKey(taskId, paneId);
	bump(paneGeneration, key);
	lastTurn.delete(key);
	dropPending(key, (exit) => !exit.typed && !exit.closing);
}

/** The task's terminal is torn down: every pane of it is gone. */
export function forgetTaskExitState(taskId: string): void {
	const prefix = `${taskId}:`;
	bump(taskGeneration, taskId);
	for (const key of [...lastTurn.keys(), ...pending.keys()]) {
		if (!key.startsWith(prefix)) continue;
		lastTurn.delete(key);
		dropPending(key, () => true);
	}
}

export function resetExtraAgentExitStateForTests(): void {
	paneGeneration.clear();
	taskGeneration.clear();
	for (const key of [...pending.keys()]) dropPending(key, () => true);
	lastTurn.clear();
}
