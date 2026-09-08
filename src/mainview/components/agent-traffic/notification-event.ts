/**
 * Normalize archived `dev3 notify` rows into the notification arm of the traffic
 * timeline. Assembling the arms into one union, and ordering them, belongs to the
 * owner of the replay cursor — see `traffic-timeline.ts`.
 *
 * Why a normalizer rather than passing rows around: three rules about a
 * notification are easy to get wrong and expensive to get wrong, so they are
 * decided once, here, instead of at every render site.
 *
 * 1. An UNRECORDED source invents nothing. A row can carry `taskId: null` and
 *    `sourceTaskId: null`, and both nulls mean "the archive did not record this" —
 *    not "there was no worktree" and not "nobody sent it". An event with no
 *    endpoint at all is unanchored: it belongs to the timeline and to no card, and
 *    must never be attached to a neighbouring node because one happened to be
 *    nearby.
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
	 * Stable across a refresh, a prepend and a longer page: a fingerprint of the
	 * row plus how many identical rows sit NEWER than it. Two genuinely identical
	 * notifications keep two events rather than collapsing into one, and neither a
	 * new row nor a revealed older row renumbers what already had a key.
	 */
	key: string;
	/** Epoch ms of `row.at`. */
	at: number;
	/** The archive row, verbatim. */
	row: NotificationLogRow;
	/** The card this is about, or null when the archive recorded none. */
	target: NotificationEndpoint | null;
	/** The card it was sent from, or null when the archive recorded no source. */
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
	// Counted from the NEWEST end, which is the order `rows` already arrives in.
	//
	// This is load-bearing and was got wrong once. Two genuinely identical rows are
	// told apart only by how many identical rows sit beside them, and the page is
	// truncated at `limit` from the OLD end — so counting from the oldest row in the
	// page renumbers every duplicate the moment a longer page reveals an older one,
	// and every key changes on "load more". Counting from the newest end is stable
	// under pagination: an older row appearing takes the next index up and touches
	// nothing already numbered. A live append cannot disturb it either, because two
	// rows identical to the millisecond would have to arrive for the group to grow
	// at the new end, and the writer already de-duplicates the fan-out that could
	// produce them.
	for (const row of rows) {
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
	// Built newest-first for stable keys, returned oldest-first because that is the
	// order a timeline is read in.
	return events.reverse();
}

/* ── the notification arm of the shared timeline ─────────────────────────── */

/**
 * The notification arm, and nothing else.
 *
 * The union itself, its `KIND_RANK` and the merge live in
 * `traffic-timeline.ts` and belong to the owner of the replay cursor — one
 * canonical declaration, agreed after this module briefly carried its own. What
 * stays here is the shape of this one arm, which is what the notification side
 * actually owns.
 */
export interface TrafficNotificationTimelineEvent {
	kind: "notification";
	at: number;
	key: string;
	event: TrafficNotificationEvent;
}

/** Wrap notification events as timeline arms, oldest first, keys namespaced. */
export function notificationTimelineEvents(events: readonly TrafficNotificationEvent[]): TrafficNotificationTimelineEvent[] {
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
 * `at === null` is the cursor's LIVE position: everything is shown, bounded by
 * the window measured back from the newest event rather than from wall-clock
 * time, so a live view of an archive that ended hours ago is not empty.
 *
 * `windowMs` keeps the readout bounded during a burst: without it, a minute with
 * fifty notifications in it would try to render fifty clouds at once.
 */
export function notificationsAt(
	events: readonly TrafficNotificationEvent[],
	at: number | null,
	options: { windowMs?: number; max?: number } = {},
): TrafficNotificationEvent[] {
	if (at === null) {
		const newest = events[events.length - 1];
		if (!newest) return [];
		return notificationsAt(events, newest.at, options);
	}
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

/* ── the level axis and the notification count ───────────────────────────── */

/**
 * The `levels` axis of the shared timeline filter, which governs notification
 * events and nothing else — a message filter must never swallow a notification,
 * and a level means nothing to a message or a board movement.
 *
 * A SET, matching the shared filter: all three present is the default "show
 * everything", and an empty set means the reader has unticked every level and
 * wants no notifications at all. That is the opposite of an omitted filter, so it
 * is not expressible here on purpose — an "off" axis is the caller's business.
 */
export type NotificationLevelFilter = ReadonlySet<NotificationLogLevel>;

/** Every level, in the order a control should list them: worst news first. */
export const NOTIFICATION_LEVELS: readonly NotificationLogLevel[] = ["error", "success", "info"];

/** i18n key for a level's label, so a control and a cloud never disagree. */
export function notificationLevelKey(level: NotificationLogLevel): `traffic.notification.level.${NotificationLogLevel}` {
	return `traffic.notification.level.${level}`;
}

/**
 * The level half of the shared predicate. Trivial by design: the shared
 * `matchesTimelineFilter` owns the `kinds` gate and the message-delivery gate,
 * and calls into this for the notification arm.
 */
export function notificationPassesLevels(event: TrafficNotificationEvent, levels: NotificationLevelFilter): boolean {
	return levels.has(event.level);
}

/**
 * Counts for the controls.
 *
 * `total` counts NOTIFICATIONS ONLY and must never be folded into a message
 * count — they are different kinds of event, and one number covering both
 * answers neither question. `neverSeen` is the one that earns its place: how
 * many of these the user may never have laid eyes on, which is the whole reason
 * the archive exists.
 */
export interface NotificationCounts {
	total: number;
	byLevel: Record<NotificationLogLevel, number>;
	byOutcome: Record<NotificationLogOutcome, number>;
	/** `queued` + `no-window`: recorded, but possibly never seen. */
	neverSeen: number;
}

export function notificationCounts(events: readonly TrafficNotificationEvent[]): NotificationCounts {
	const counts: NotificationCounts = {
		total: 0,
		byLevel: { info: 0, success: 0, error: 0 },
		byOutcome: { delivered: 0, queued: 0, "no-window": 0 },
		neverSeen: 0,
	};
	for (const event of events) {
		counts.total += 1;
		counts.byLevel[event.level] += 1;
		counts.byOutcome[event.outcome] += 1;
		if (event.outcome !== "delivered") counts.neverSeen += 1;
	}
	return counts;
}
