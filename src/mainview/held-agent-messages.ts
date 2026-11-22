import { useSyncExternalStore } from "react";
import { api } from "./rpc";

/**
 * Per task, how many `dev3 message`s wait behind an open agent prompt (#2342). Lives in
 * the bun process's memory; this mirror is filled once and then kept by the
 * `heldAgentMessages` push, so every card reads it without its own request.
 */
let counts: Record<string, number> = {};
const listeners = new Set<() => void>();
let started = false;

function emit(): void {
	for (const listener of listeners) listener();
}

function set(taskId: string, count: number): void {
	if ((counts[taskId] ?? 0) === count) return;
	const next = { ...counts };
	if (count > 0) next[taskId] = count;
	else delete next[taskId];
	counts = next;
	emit();
}

function start(): void {
	if (started) return;
	started = true;
	window.addEventListener("rpc:heldAgentMessages", (e) => {
		const { taskId, count } = (e as CustomEvent<{ taskId: string; count: number }>).detail;
		if (taskId) set(taskId, count);
	});
	void Promise.resolve().then(() => api.request.getHeldAgentMessageCounts({})).then((initial) => {
		for (const [taskId, count] of Object.entries(initial ?? {})) set(taskId, count);
	}).catch(() => { /* No count is the same as nothing waiting: the next push fills it. */ });
}

function subscribe(listener: () => void): () => void {
	start();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useHeldAgentMessageCount(taskId: string): number {
	return useSyncExternalStore(subscribe, () => counts[taskId] ?? 0);
}

/** The app holds nothing for this task (Send now released none): drop a stale count. */
export function clearHeldAgentMessageCount(taskId: string): void {
	set(taskId, 0);
}

/** Tests only. */
export function _resetHeldAgentMessageCounts(): void {
	counts = {};
	started = false;
	listeners.clear();
}
