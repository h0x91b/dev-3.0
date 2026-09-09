/**
 * Turn archived `dev3 notify` rows into events a reader can render.
 *
 * Data only: no component, no styling, no timeline. It lives beside the store
 * that fetches the rows rather than under `components/`, because nothing here
 * knows what a notification looks like on screen.
 *
 * Why a normalizer rather than passing rows around: three rules about a
 * notification are easy to get wrong and expensive to get wrong, so they are
 * decided once, here, instead of at every render site.
 *
 * 1. An UNRECORDED source invents nothing. A row can carry `taskId: null` and
 *    `sourceTaskId: null`, and both nulls mean "the archive did not record this" —
 *    not "there was no worktree" and not "nobody sent it". An event with no
 *    endpoint at all is unanchored: it belongs to no card, and must never be
 *    attached to a neighbouring one because one happened to be nearby.
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
} from "../shared/notification-log";

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
