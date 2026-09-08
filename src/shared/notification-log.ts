/**
 * The on-disk shape of one `dev3 notify` call, and the rules that keep the file
 * append-only and safe for two app instances at once.
 *
 * A notification is the loudest thing an agent can do and the only one that
 * leaves no trace: a toast lives 5 seconds, an OS notification is gone once the
 * user dismisses it, and a notification that arrived during Focus Mode may never
 * be seen at all. This log records the request and what the app did with it, so
 * "did it ping me while I was away, and about what" has an answer.
 *
 * Deliberately NOT the agent message log: `dev3 message` types into another
 * task's agent and always has a sender and a recipient task, while a
 * notification is addressed to the human and may carry no task at all. Folding
 * one into the other would make both unreadable.
 *
 * Pure and shared: the writer, any future reader and the renderer all speak this
 * type, so a row can never mean two different things at the two ends.
 */

/** Schema version. Bumped only when a reader must branch; readers skip unknown values. */
export const NOTIFICATION_LOG_VERSION = 1;

/**
 * Hard ceiling on one serialised row, including its newline.
 *
 * Load-bearing for concurrency, not for disk: appends from two processes are
 * interleaving-safe only while each row is a single `write()`. The CLI already
 * caps a message at 500 characters, so a real row sits far below this.
 */
export const NOTIFICATION_LOG_MAX_ROW_BYTES = 4_096;

/** Days of history kept. Older day-files are deleted, not compacted. */
export const NOTIFICATION_LOG_RETENTION_DAYS = 30;

/** Marker appended to a message clipped by {@link NOTIFICATION_LOG_MAX_ROW_BYTES}. */
export const NOTIFICATION_LOG_TRUNCATION_MARK = "…[truncated by the notification log]";

/** In-app toast versus a native OS notification (`--desktop`). */
export type NotificationLogMode = "toast" | "desktop";

/** The `--level` an agent chose. Same three values the CLI accepts. */
export type NotificationLogLevel = "info" | "success" | "error";

/**
 * What the app did with the request — the request and its fate are separate
 * facts, and a log that recorded only "notify was called" would answer nothing.
 *
 * - `delivered` — handed to an open window (toast) or fired natively (desktop).
 * - `queued` — Focus Mode or immersive terminal held it back for a later flush.
 *   Whether the user ever saw the flush is not knowable here.
 * - `no-window` — the app was running with no window to show it in; nothing
 *   appeared and nothing was queued.
 */
export type NotificationLogOutcome = "delivered" | "queued" | "no-window";

/** Why delivery was held back, when it was. Mirrors `NotificationSuppressionSource`. */
export type NotificationLogSuppression = "focusMode" | "terminalImmersive";

/** One notification request and its outcome. Written once, never amended. */
export interface NotificationLogRow {
	v: number;
	/** ISO timestamp of when the app handled the request, not of authoring. */
	at: string;
	mode: NotificationLogMode;
	level: NotificationLogLevel;
	/** The text as the agent wrote it, clipped only by the row ceiling. */
	message: string;
	/** Custom toast lifetime in milliseconds, on `--duration` calls only. */
	durationMs?: number;

	/** Task the notification points at — null when it was sent without one. */
	taskId: string | null;
	taskSeq: number | null;
	taskTitle?: string;
	projectId: string | null;
	projectName?: string;

	/**
	 * The worktree the command actually ran in, which is NOT always the task the
	 * notification points at: `dev3 notify --task <other>` addresses someone
	 * else's card. Null when the caller was not inside a worktree (a human shell,
	 * a script), and that null is a real answer rather than a gap to fill.
	 */
	sourceTaskId: string | null;
	sourceSeq: number | null;
	sourceTitle?: string;
	sourceProjectId?: string;
	/**
	 * The harness session id the caller's environment carried, when it carried
	 * one (`CLAUDE_CODE_SESSION_ID` today). It separates two agent sessions in one
	 * task; it does NOT separate a sub-agent from its parent, because a Claude
	 * Code sub-agent inherits the parent's id verbatim — measured, not assumed.
	 * Absent for every harness that exposes nothing, and absence stays absence.
	 */
	sourceSessionId?: string;

	outcome: NotificationLogOutcome;
	/** Present only on `queued` rows: every suppression source that was active. */
	suppressedBy?: NotificationLogSuppression[];
}

/** Everything needed to write a row, minus the version. */
export type NotificationLogInput = Omit<NotificationLogRow, "v">;

/** One page of history, as a reader returns it. */
export interface NotificationLogPage {
	/** Newest first. */
	rows: NotificationLogRow[];
	/**
	 * The oldest day still on disk (`YYYY-MM-DD`), or null when there is no
	 * history at all. Trimmed history must read as trimmed, not as silence:
	 * everything before this day was deleted by the retention policy.
	 */
	oldestDay: string | null;
	/**
	 * The newest day on disk (`YYYY-MM-DD`), or null when there is no history.
	 *
	 * Together with {@link oldestDay} this is the ONLY honest answer to "how far
	 * back does this go" — the collection started when the writer shipped, not
	 * when the app was installed, and a reader that assumed 30 days of history
	 * would invent the difference.
	 */
	newestDay: string | null;
	/** Days of history the retention policy keeps. */
	retentionDays: number;
	/** True when `limit` cut the answer short and older rows still exist on disk. */
	hasMore: boolean;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Clip `message` so the whole row fits the ceiling. Returns the text to store. */
export function clampNotificationMessage(message: string, overheadBytes: number): string {
	const budget = NOTIFICATION_LOG_MAX_ROW_BYTES - overheadBytes - utf8Bytes(NOTIFICATION_LOG_TRUNCATION_MARK);
	if (utf8Bytes(message) <= NOTIFICATION_LOG_MAX_ROW_BYTES - overheadBytes) return message;
	if (budget <= 0) return NOTIFICATION_LOG_TRUNCATION_MARK;
	// Walk back from the byte budget so a multi-byte character is never cut in half.
	let end = Math.min(message.length, budget);
	while (end > 0 && utf8Bytes(message.slice(0, end)) > budget) end -= 1;
	return message.slice(0, end) + NOTIFICATION_LOG_TRUNCATION_MARK;
}

/**
 * Serialise one row into exactly one line, guaranteed to fit the ceiling.
 *
 * The message is clamped against the size of everything else, so a long message
 * shrinks and the metadata always survives — a row whose outcome had been
 * dropped would be worthless.
 */
export function serializeNotificationLogRow(input: NotificationLogInput): string {
	const row: NotificationLogRow = { v: NOTIFICATION_LOG_VERSION, ...input };
	const line = `${JSON.stringify(row)}\n`;
	if (utf8Bytes(line) <= NOTIFICATION_LOG_MAX_ROW_BYTES) return line;
	const overhead = utf8Bytes(`${JSON.stringify({ ...row, message: "" })}\n`);
	return `${JSON.stringify({ ...row, message: clampNotificationMessage(row.message, overhead) })}\n`;
}

/**
 * Parse one line, or null when it cannot be trusted.
 *
 * A torn or half-written line is expected rather than exceptional: the app can
 * be killed mid-append, and a reader that threw on one bad byte would lose the
 * whole day. Anything without a timestamp, a message and an outcome is discarded.
 */
export function parseNotificationLogRow(line: string): NotificationLogRow | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const row = parsed as Partial<NotificationLogRow>;
	if (typeof row.at !== "string" || typeof row.message !== "string") return null;
	if (typeof row.mode !== "string" || typeof row.level !== "string" || typeof row.outcome !== "string") return null;
	return row as NotificationLogRow;
}
