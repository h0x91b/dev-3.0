/**
 * Normalize archived `dev3 notify` rows into timeline events, and merge them with
 * the other kinds of thing the traffic timeline shows.
 *
 * Why a normalizer rather than passing rows around: three rules about a
 * notification are easy to get wrong and expensive to get wrong, so they are
 * decided once, here, instead of at every render site.
 *
 * 1. A MISSING source invents nothing. `dev3 notify "done"` from a plain shell
 *    records `taskId: null` and `sourceTaskId: null`, and both nulls are real
 *    answers. An event with no target is unanchored — it belongs to the timeline
 *    and to no card. It must never be attached to a neighbouring node because one
 *    happened to be nearby.
 * 2. A CLAIMED source is not a trusted identity. `sourceSessionId` separates two
 *    agent sessions in one task and nothing more: a Claude Code sub-agent inherits
 *    its parent's id verbatim (measured, see `shared/notification-log.ts`), so it
 *    is never rendered as "sent by sub-agent X". `taskTitle`/`sourceTitle` are
 *    snapshots of what the title was at write time, not the task's live name.
 * 3. The REQUEST and its FATE are separate facts. `queued` and `no-window` mean
 *    the user may never have seen it; folding them into `delivered` would answer
 *    the one question the archive exists to answer.
 */

import type {
	NotificationLogLevel,
	NotificationLogMode,
	NotificationLogOutcome,
	NotificationLogRow,
	NotificationLogSuppression,
} from "../../../shared/notification-log";
import type { TrafficRecord } from "./traffic-model";

/** A task a notification points at, or came from. Ids only — identity is the board's job. */
export interface NotificationEndpoint {
	projectId: string;
	taskId: string;
	/** Seq as recorded, not as it is now. Null when the archive did not have one. */
	seq: number | null;
	/** Title as recorded. Absent when the archive did not have one. */
	title?: string;
}

/** One archived notification, ready to render. */
export interface TrafficNotificationEvent {
	/**
	 * Stable across re-reads and across prepends: a fingerprint of the row plus
	 * how many identical rows preceded it chronologically. Two genuinely identical
	 * notifications keep two events, and a newer row cannot renumber an older one.
	 */
	key: string;
	/** Epoch ms of `row.at`. */
	at: number;
	/** The archive row, verbatim. */
	row: NotificationLogRow;
	/** The card this points at, or null when the archive names none. */
	target: NotificationEndpoint | null;
	/** The worktree it was called from, or null when it was not called from one. */
	origin: NotificationEndpoint | null;
	/** True when both ends exist and are different cards — `notify --task <other>`. */
	crossAddressed: boolean;
	level: NotificationLogLevel;
	mode: NotificationLogMode;
	outcome: NotificationLogOutcome;
	/** Sources that held delivery back. Empty unless `outcome === "queued"`. */
	suppressedBy: NotificationLogSuppression[];
}

function endpoint(projectId: string | null, taskId: string | null, seq: number | null, title?: string): NotificationEndpoint | null {
	if (!projectId || !taskId) return null;
	return { projectId, taskId, seq, ...(title ? { title } : {}) };
}

/**
 * Chronological (oldest first) events for `rows`, which arrive newest first.
 *
 * A row whose `at` cannot be parsed is DROPPED rather than coerced to epoch 0 —
 * a timestamp of "1970" would sort a broken row in front of real history and
 * make the replay lie about when things happened.
 */
export function notificationEvents(rows: readonly NotificationLogRow[]): TrafficNotificationEvent[] {
	const occurrences = new Map<string, number>();
	const events: TrafficNotificationEvent[] = [];
	// Oldest first, so an occurrence index belongs to the row that earned it and a
	// newly prepended duplicate takes the next index rather than stealing one.
	for (const row of [...rows].reverse()) {
		const at = Date.parse(row.at);
		if (!Number.isFinite(at)) continue;
		const fingerprint = JSON.stringify(row);
		const occurrence = occurrences.get(fingerprint) ?? 0;
		occurrences.set(fingerprint, occurrence + 1);
		const target = endpoint(row.projectId, row.taskId, row.taskSeq, row.taskTitle);
		const origin = endpoint(row.sourceProjectId ?? row.projectId, row.sourceTaskId, row.sourceSeq, row.sourceTitle);
		events.push({
			key: `notification:${fingerprint}:${occurrence}`,
			at,
			row,
			target,
			origin,
			crossAddressed: !!target && !!origin && target.taskId !== origin.taskId,
			level: row.level,
			mode: row.mode,
			outcome: row.outcome,
			suppressedBy: row.outcome === "queued" ? row.suppressedBy ?? [] : [],
		});
	}
	return events;
}

/* ── the shared timeline ─────────────────────────────────────────────────── */

/**
 * One thing that happened, whatever kind it is.
 *
 * The `task` arm is declared here so the sort below is total, but its payload
 * belongs to whoever owns historical task projection — this module never
 * constructs one.
 */
export type TrafficTimelineEvent =
	| { kind: "message"; at: number; key: string; record: TrafficRecord }
	| { kind: "notification"; at: number; key: string; event: TrafficNotificationEvent }
	| { kind: "task"; at: number; key: string; payload: unknown };

/**
 * Fixed order for events sharing a timestamp. A literal rather than a derived
 * order: a rank that came out of `Object.keys` would silently change the replay
 * when an arm is added.
 */
export const TIMELINE_KIND_RANK: Record<TrafficTimelineEvent["kind"], number> = {
	message: 0,
	notification: 1,
	task: 2,
};

/**
 * Merge any number of already-built streams into one chronological timeline.
 *
 * Total and stable: equal timestamps break by kind, then by key. The same input
 * always produces the same sequence, so a replay is reproducible and a seek
 * backwards lands on exactly the frame it left.
 */
export function mergeTrafficTimeline(...streams: readonly TrafficTimelineEvent[][]): TrafficTimelineEvent[] {
	return streams.flat().sort((a, b) =>
		a.at - b.at
		|| TIMELINE_KIND_RANK[a.kind] - TIMELINE_KIND_RANK[b.kind]
		|| (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Wrap notification events as timeline arms. */
export function notificationTimelineEvents(events: readonly TrafficNotificationEvent[]): TrafficTimelineEvent[] {
	return events.map(event => ({ kind: "notification" as const, at: event.at, key: event.key, event }));
}

/**
 * The events a cursor sitting at `at` has already crossed, newest first.
 *
 * Time-based rather than index-based on purpose: it is the only selection that
 * gives the same answer when the cursor arrives from the left (playing forward),
 * from the right (seeking backwards) or from nowhere (a restart), and it stays
 * correct when a live append lands behind the cursor.
 *
 * `window` keeps the readout bounded during a burst: without it, a minute with
 * fifty notifications in it would try to render fifty bubbles at once.
 */
export function notificationsAt(
	events: readonly TrafficNotificationEvent[],
	at: number,
	options: { windowMs?: number; max?: number } = {},
): TrafficNotificationEvent[] {
	if (!Number.isFinite(at)) return [];
	const windowMs = options.windowMs ?? 0;
	const max = options.max ?? 3;
	const crossed: TrafficNotificationEvent[] = [];
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.at > at) continue;
		if (windowMs > 0 && at - event.at > windowMs) break;
		crossed.push(event);
		if (crossed.length >= max) break;
	}
	return crossed;
}
