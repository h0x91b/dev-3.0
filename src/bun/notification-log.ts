/**
 * Append-only log of every `dev3 notify` the app handled.
 *
 * Layout: `~/.dev3.0/notifications/YYYY-MM-DD.jsonl` — a NEW top-level directory
 * beside `data/` and `logs/`, which is the only shape the on-disk invariants in
 * AGENTS.md allow. Nothing existing is renamed, nothing is migrated, and an older
 * app version simply never opens this directory.
 *
 * Why global rather than per-project like the message log: a notification can be
 * sent with no task and therefore no project (`dev3 notify "done"` from any
 * shell). Splitting the same event stream by whether a task happened to be in
 * context would make "every notification, in order" impossible to read in one
 * pass. Every row carries its `projectId`, so a per-project view is a filter.
 *
 * Why one file per day: retention has to be real, and trimming a single
 * append-only file means rewriting it — which stops being append-only and loses
 * rows when two app instances do it at the same moment. Deleting a whole expired
 * day-file needs no rewrite and no rename.
 *
 * Concurrency: one row is one `appendFileSync` on a file opened `O_APPEND`, so
 * the kernel serialises the seek-and-write and two processes can never overwrite
 * each other's bytes. Rows are capped at `NOTIFICATION_LOG_MAX_ROW_BYTES` so a
 * single `write()` always carries the whole line. A reader that meets a torn
 * line skips it.
 *
 * Privacy: messages land unencrypted, exactly as the agents wrote them. The file
 * is `0600`, same as the message log, and nothing leaves the machine — this log
 * has no telemetry path and is never uploaded.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { NOTIFICATION_LOG_RETENTION_DAYS, type NotificationLogInput, serializeNotificationLogRow } from "../shared/notification-log";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("notification-log");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** Local-day stamp, matching the message log's convention. */
function dayStamp(at: Date): string {
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The directory holding the day-files. */
export function notificationLogDir(): string {
	return `${DEV3_HOME}/notifications`;
}

function dayFile(at: Date): string {
	return `${notificationLogDir()}/${dayStamp(at)}.jsonl`;
}

function parseDay(fileName: string): number | null {
	const match = DAY_FILE_RE.exec(fileName);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}

/**
 * Delete day-files outside the retention window. Best-effort and silent: a
 * concurrent writer or a permission change must never break a notification.
 * Returns how many files went.
 */
export function pruneNotificationLog(now: Date = new Date()): number {
	const dir = notificationLogDir();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const cutoff = today - (NOTIFICATION_LOG_RETENTION_DAYS - 1) * DAY_MS;
	let removed = 0;
	try {
		for (const name of readdirSync(dir)) {
			const day = parseDay(name);
			if (day === null || day >= cutoff) continue;
			try {
				unlinkSync(`${dir}/${name}`);
				removed += 1;
			} catch {
				// Another instance may have removed it already.
			}
		}
	} catch {
		// No directory yet, or unreadable — nothing to prune.
	}
	return removed;
}

let lastPrunedDay: string | null = null;

function pruneIfNeeded(now: Date): void {
	const today = dayStamp(now);
	if (lastPrunedDay === today) return;
	lastPrunedDay = today;
	pruneNotificationLog(now);
}

/** Test seam: forget that today was already pruned. */
export function resetNotificationLogPruneState(): void {
	lastPrunedDay = null;
}

/**
 * Append one row. Never throws: a notification the user already saw must not be
 * reported as failed because a log write lost a race with a disk error.
 */
export function appendNotificationLog(input: NotificationLogInput, now: Date = new Date()): void {
	const line = serializeNotificationLogRow(input);
	try {
		mkdirSync(notificationLogDir(), { recursive: true });
		appendFileSync(dayFile(now), line, { mode: 0o600 });
	} catch (err) {
		log.warn("Failed to append to the notification log", { error: String(err) });
		return;
	}
	pruneIfNeeded(now);
}
