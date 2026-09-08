/**
 * The one ordered thing replay walks: task movements, messages and notifications
 * in a single union.
 *
 * Replay used to be an index into `TrafficRecord[]`, which cannot express "at
 * 07:12 a task moved and nobody said anything". An hour with board activity and
 * no messages had zero steps, so cards could only change state when a message
 * happened to arrive nearby. Indexing the union instead makes every recorded
 * fact a step of its own, at its own instant.
 *
 * Agreed with Seq 1825 (notifications) and Seq 1824 (hour entry) as contract v2.
 */

import type { Task, TaskMovement } from "../../../shared/types";
import { getTaskTitle } from "../../../shared/types";
import type { TrafficNotificationEvent as NormalizedNotification } from "./notification-event";
import { endpointKey, type TrafficRecord } from "./traffic-model";

export type TrafficTimelineEventKind = "task" | "message" | "notification";

/** One recorded board movement, addressed to the card it moved. */
export interface TrafficTaskEvent {
	kind: "task";
	at: number;
	key: string;
	movement: TaskMovement;
	node: { projectId: string; taskId: string };
	/** Node key, so a consumer can look the card up without rebuilding it. */
	nodeKey: string;
	seq: number | null;
	title: string;
}

export interface TrafficMessageEvent {
	kind: "message";
	at: number;
	key: string;
	record: TrafficRecord;
}

/**
 * The notification arm. The payload is Seq 1825's normalized event, imported
 * rather than restated — one declaration, so the two ends cannot drift. Their
 * module deliberately does not import this one, so there is no cycle.
 */
export interface TrafficNotificationEvent {
	kind: "notification";
	at: number;
	key: string;
	event: NormalizedNotification;
}

export type TrafficTimelineEvent =
	| TrafficTaskEvent
	| TrafficMessageEvent
	| TrafficNotificationEvent;

/**
 * Same-instant order, a literal rather than a derived one — a rank that fell out
 * of `Object.keys` would silently change the replay when an arm is added.
 *
 * Task first is load-bearing, not alphabetical: a message or a notification
 * stamped at the same millisecond as a `created` movement must land on a card
 * that already exists. Ranking `task` last — the obvious first guess, and what
 * the first draft of this contract had — renders a bubble against a card that
 * has not appeared yet.
 */
export const TIMELINE_KIND_RANK: Record<TrafficTimelineEventKind, number> = {
	task: 0,
	message: 1,
	notification: 2,
};

/**
 * Total, stable order: time, then kind rank, then key. Keys carry an occurrence
 * index, so a prepend can never renumber what came before.
 */
export function sortTimeline(
	events: readonly TrafficTimelineEvent[],
): TrafficTimelineEvent[] {
	return [...events].sort(
		(a, b) =>
			a.at - b.at ||
			TIMELINE_KIND_RANK[a.kind] - TIMELINE_KIND_RANK[b.kind] ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	);
}

/** Merge already-built streams into one timeline. Seq 1825's entry point. */
export function mergeTrafficTimeline(
	...streams: readonly TrafficTimelineEvent[][]
): TrafficTimelineEvent[] {
	return sortTimeline(streams.flat());
}

/**
 * Board movements inside `[start, end)` as timeline events.
 *
 * Only what is written down: a task with no `movements[]` contributes nothing at
 * all rather than a synthesised "created" at `createdAt`, which would be an
 * invented instant. `movementsDropped` is not represented either — an evicted
 * movement has no timestamp left to place.
 */
export function taskEvents(
	tasks: Task[],
	start: number,
	end: number,
): TrafficTaskEvent[] {
	const events: TrafficTaskEvent[] = [];
	for (const task of tasks) {
		for (const movement of task.movements ?? []) {
			const at = Date.parse(movement.at);
			// An unparseable instant is dropped, never coerced to 0 — a bogus 1970
			// event would sort ahead of every real one and appear to be the start.
			if (!Number.isFinite(at) || at < start || at >= end) continue;
			events.push({
				kind: "task",
				at,
				key: `task:${task.projectId}:${task.id}:${movement.id}`,
				movement,
				node: { projectId: task.projectId, taskId: task.id },
				nodeKey: endpointKey(task.projectId, task.id),
				seq: task.seq,
				title: getTaskTitle(task),
			});
		}
	}
	return events;
}

/**
 * Messages as timeline events, keeping the record keys the surface already uses.
 *
 * `bounds` is optional because most callers hand over records the window has
 * already filtered — but `buildTimeline` always passes it, so every arm is
 * clipped by exactly the same interval rather than each caller being trusted to
 * have done it. A window that holds for two arms and not the third is the kind
 * of asymmetry nobody notices until an event appears outside the range.
 */
export function messageEvents(
	records: readonly TrafficRecord[],
	bounds?: { start: number; end: number },
): TrafficMessageEvent[] {
	const events: TrafficMessageEvent[] = [];
	for (const record of records) {
		const at = Date.parse(record.row.at);
		if (!Number.isFinite(at)) continue;
		if (bounds && (at < bounds.start || at >= bounds.end)) continue;
		events.push({ kind: "message", at, key: `message:${record.key}`, record });
	}
	return events;
}

/**
 * Assemble the replay timeline. Notifications arrive already normalized from
 * Seq 1825's reader; passing them in rather than reading them here keeps this
 * module free of their RPC and testable on its own.
 */
export function buildTimeline(input: {
	records: TrafficRecord[];
	tasks: Task[];
	start: number;
	end: number;
	notifications?: TrafficNotificationEvent[];
}): TrafficTimelineEvent[] {
	const notifications = (input.notifications ?? []).filter(
		(event) =>
			Number.isFinite(event.at) &&
			event.at >= input.start &&
			event.at < input.end,
	);
	return sortTimeline([
		...taskEvents(input.tasks, input.start, input.end),
		...messageEvents(input.records, { start: input.start, end: input.end }),
		...notifications,
	]);
}

/**
 * The last message at or before the cursor, for the surfaces that still speak in
 * messages — the flying wire, the subject bubble, the message list. A task or
 * notification step must not blank the wire that was lit a moment ago, and must
 * not light one that has not happened.
 */
export function messageAt(
	events: TrafficTimelineEvent[],
	index: number,
): TrafficRecord | null {
	for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
		const event = events[i];
		if (event.kind === "message") return event.record;
	}
	return null;
}

/**
 * Index of the first event at or after `at`, or -1 when every event precedes it.
 * This is what an entry range ("open on the last hour") seeks to; Seq 1824 calls
 * it through `playback.seekToTime`.
 */
export function indexAtOrAfter(
	events: TrafficTimelineEvent[],
	at: number,
): number {
	for (let i = 0; i < events.length; i++) if (events[i].at >= at) return i;
	return -1;
}
