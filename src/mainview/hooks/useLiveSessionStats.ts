import { useSyncExternalStore } from "react";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import type { AgentSessionStats } from "../../shared/session-stats";
import { api } from "../rpc";

// One board-wide subscription to the per-task statusLine stats, so every task card
// shares a single fetch and a single push listener instead of one each.
let byTask: ReadonlyMap<string, AgentSessionStats> = new Map();
let appliedAt = -Infinity;
const listeners = new Set<() => void>();
let started = false;

function apply(report: AgentRateLimitsReport | null | undefined): void {
	// The first fetch can land after a newer push; never let it roll the stats back.
	if (!report || report.generatedAt < appliedAt) return;
	appliedAt = report.generatedAt;
	const next = new Map<string, AgentSessionStats>();
	// Sessions arrive newest first; keep the first one seen per task.
	for (const s of report.sessions ?? []) if (!next.has(s.taskId)) next.set(s.taskId, s);
	byTask = next;
	for (const listener of listeners) listener();
}

function onUpdate(e: Event): void {
	apply((e as CustomEvent).detail as AgentRateLimitsReport);
}

function start(): void {
	if (started) return;
	started = true;
	window.addEventListener("rpc:agentRateLimitsUpdated", onUpdate);
	try {
		api.request.getAgentRateLimits().then(apply).catch(() => {
			// backend not ready - the first push fills it in
		});
	} catch {
		// no RPC transport (tests, a torn-down bridge) - pushes still apply
	}
}

function subscribe(listener: () => void): () => void {
	start();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The live statusLine stats of one task's Claude session, or null when none is fresh. */
export function useLiveSessionStats(taskId: string): AgentSessionStats | null {
	return useSyncExternalStore(subscribe, () => byTask.get(taskId) ?? null);
}

/** Test seam: forget the subscription and the cached stats. */
export function resetLiveSessionStatsForTests(): void {
	window.removeEventListener("rpc:agentRateLimitsUpdated", onUpdate);
	started = false;
	byTask = new Map();
	appliedAt = -Infinity;
	listeners.clear();
}
