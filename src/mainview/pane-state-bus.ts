/**
 * One arrival point for a task's pane state (seq 1382).
 *
 * The toolbar that mutates panes (`TaskPaneControls`, inside the inspector) and the
 * canvas that draws them (`TaskTerminal`) are separate component trees. Each used to
 * keep its own copy of `TaskPaneState`, so a toolbar action updated the toolbar and
 * the canvas only caught up on its next poll tick — up to 2.5s of apparent
 * inertness for work the backend finished in tens of milliseconds.
 *
 * Every read and every action goes through here and the SERVER's own response is
 * broadcast to all subscribers. Nothing on this path computes a layout locally:
 * a client-invented tree is exactly the divergence the native pane surface forbids.
 *
 * Each request takes a ticket before it leaves; a response whose ticket is older
 * than one already delivered is dropped, so a slow poll that resolves after a fast
 * action can never reinstate the pre-action geometry.
 */

import { api } from "./rpc";
import type { TaskPaneAction, TaskPaneState } from "../shared/task-panes";

export const PANE_STATE_EVENT = "panes:stateChanged";

export interface PaneStateEventDetail {
	taskId: string;
	state: TaskPaneState;
}

const nextTicket = new Map<string, number>();
const deliveredTicket = new Map<string, number>();

function takeTicket(taskId: string): number {
	const ticket = (nextTicket.get(taskId) ?? 0) + 1;
	nextTicket.set(taskId, ticket);
	return ticket;
}

/** Broadcast a server response. Returns false when a newer one already landed. */
function deliver(taskId: string, ticket: number, state: TaskPaneState): boolean {
	if (ticket <= (deliveredTicket.get(taskId) ?? 0)) return false;
	deliveredTicket.set(taskId, ticket);
	window.dispatchEvent(
		new CustomEvent<PaneStateEventDetail>(PANE_STATE_EVENT, { detail: { taskId, state } }),
	);
	return true;
}

export function subscribePaneState(taskId: string, onState: (state: TaskPaneState) => void): () => void {
	function handler(event: Event) {
		const detail = (event as CustomEvent<PaneStateEventDetail>).detail;
		if (detail.taskId !== taskId) return;
		onState(detail.state);
	}
	window.addEventListener(PANE_STATE_EVENT, handler);
	return () => window.removeEventListener(PANE_STATE_EVENT, handler);
}

/** Read pane state and broadcast it. Used by the reconciliation polls. */
export async function fetchPaneState(taskId: string): Promise<TaskPaneState> {
	const ticket = takeTicket(taskId);
	const state = await api.request.taskPaneState({ taskId });
	deliver(taskId, ticket, state);
	return state;
}

/** Run a pane action and broadcast the state it returns, before any poll tick. */
export async function runPaneAction(taskId: string, action: TaskPaneAction): Promise<TaskPaneState> {
	const ticket = takeTicket(taskId);
	const state = await api.request.taskPaneAction({ taskId, action });
	deliver(taskId, ticket, state);
	return state;
}

/** @internal Tests only — clears ticket bookkeeping between cases. */
export function _resetPaneStateBus(): void {
	nextTicket.clear();
	deliveredTicket.clear();
}
