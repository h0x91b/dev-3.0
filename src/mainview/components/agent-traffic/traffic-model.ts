import type { AgentMessageLogRow } from "../../../shared/agent-message-log";
import { getTaskTitle, taskSeqLabel, type Task } from "../../../shared/types";

export const endpointKey = (projectId: string, taskId: string) => JSON.stringify([projectId, taskId]);
export const fromKey = (row: AgentMessageLogRow) => row.fromTaskId ? endpointKey(row.fromProjectId ?? row.toProjectId, row.fromTaskId) : null;
export const toKey = (row: AgentMessageLogRow) => endpointKey(row.toProjectId, row.toTaskId);
export const routeKey = (row: AgentMessageLogRow) => JSON.stringify([fromKey(row), toKey(row)].sort());
export interface TrafficRecord { key: string; row: AgentMessageLogRow }
export interface TrafficNode { key: string; projectId: string; id: string; seq: number | null; title: string; task?: Task }

// Occurrences preserve identical attempts; prepending rows cannot renumber old occurrences.
export function trafficRecords(rows: AgentMessageLogRow[]): TrafficRecord[] {
	const occurrences = new Map<string, number>();
	return [...rows].reverse().map(row => {
		const fingerprint = JSON.stringify(row);
		const occurrence = occurrences.get(fingerprint) ?? 0;
		occurrences.set(fingerprint, occurrence + 1);
		return { key: `${fingerprint}:${occurrence}`, row };
	}).reverse();
}

export function trafficNodes(tasks: Task[], rows: AgentMessageLogRow[]): TrafficNode[] {
	const nodes = new Map<string, TrafficNode>();
	for (const task of tasks) {
		const key = endpointKey(task.projectId, task.id);
		nodes.set(key, { key, projectId: task.projectId, id: task.id, seq: task.seq, title: getTaskTitle(task), task });
	}
	for (const row of rows) {
		for (const [projectId, id, seq, title] of [
			[row.fromProjectId ?? row.toProjectId, row.fromTaskId, row.fromSeq, row.fromTitle],
			[row.toProjectId, row.toTaskId, row.toSeq, row.toTitle],
		] as const) {
			if (!id) continue;
			const key = endpointKey(projectId, id);
			if (!nodes.has(key)) nodes.set(key, { key, projectId, id, seq, title: title ?? "" });
		}
	}
	return [...nodes.values()];
}

export function nodeSeq(node: TrafficNode): string {
	return node.task ? `#${taskSeqLabel(node.task)}` : `#${node.seq ?? "—"}`;
}

export function positionSeed(key: string): number {
	let hash = 2166136261;
	for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return hash >>> 0;
}
