import { isUserOrigin, type AgentMessageLogRow } from "../../../shared/agent-message-log";
import { getTaskTitle, taskSeqLabel, type Task } from "../../../shared/types";

export const endpointKey = (projectId: string, taskId: string) => JSON.stringify([projectId, taskId]);

/**
 * The endpoint id standing for the person using the app.
 *
 * Not a task id and deliberately not shaped like one — a UUID could in principle
 * collide, and a reader meeting this in a key must be able to see at a glance
 * that no task is meant. One per project rather than one globally, so the marker
 * sits inside the project group its message went to instead of floating between
 * the group boxes with an edge crossing the whole scene.
 */
export const USER_ENDPOINT_ID = "dev3:user";

export const userEndpointKey = (projectId: string) => endpointKey(projectId, USER_ENDPOINT_ID);

/**
 * The sender endpoint, or null when nothing is known about who sent it.
 *
 * Three answers, not two: a task, the user, or unknown. A row with no sender is
 * still null — an artifact form submit, a dev3 hand-off and a `dev3 message` run
 * outside a worktree all look like that, and none of them is the user.
 */
export const fromKey = (row: AgentMessageLogRow) => row.fromTaskId
	? endpointKey(row.fromProjectId ?? row.toProjectId, row.fromTaskId)
	: isUserOrigin(row) ? userEndpointKey(row.toProjectId) : null;
export const toKey = (row: AgentMessageLogRow) => endpointKey(row.toProjectId, row.toTaskId);
export const routeKey = (row: AgentMessageLogRow) => JSON.stringify([fromKey(row), toKey(row)].sort());
export interface TrafficRecord { key: string; row: AgentMessageLogRow }
export interface TrafficNode {
	key: string; projectId: string; id: string; seq: number | null; title: string; task?: Task;
	/** The person using the app, not a task. Has no seq, no status and no card. */
	user?: boolean;
}

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
		// One user endpoint per project that the user actually wrote into. Never
		// pre-seeded for every project: a marker on a board the user never messaged
		// would claim an exchange that did not happen.
		if (isUserOrigin(row)) {
			const key = userEndpointKey(row.toProjectId);
			if (!nodes.has(key)) {
				nodes.set(key, { key, projectId: row.toProjectId, id: USER_ENDPOINT_ID, seq: null, title: "", user: true });
			}
		}
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

/**
 * How a row's sender reads in a list: a task's seq, the user, or an em-dash.
 *
 * Three answers in one place, because they are rendered in three (the message
 * list, the inspector and the replay strip) and two of them saying "—" while the
 * canvas says "You" would be two different facts about one message.
 * `you` is passed in rather than looked up so this file stays free of i18n.
 */
export function senderLabel(row: AgentMessageLogRow, you: string): string {
	if (row.fromSeq !== null) return `#${row.fromSeq}`;
	return isUserOrigin(row) ? you : "—";
}

export function nodeSeq(node: TrafficNode): string {
	return node.task ? `#${taskSeqLabel(node.task)}` : `#${node.seq ?? "—"}`;
}

export function positionSeed(key: string): number {
	let hash = 2166136261;
	for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return hash >>> 0;
}
