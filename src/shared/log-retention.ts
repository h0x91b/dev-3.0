/**
 * How long the agent message log and the notification log keep their day-files.
 * One global setting covers both. 30 days is the default and is stored as an
 * absent field, so an install that never touched it behaves exactly as before.
 */

/** What `settings.json` may hold: a day count, or "forever". 30 is never stored. */
export type LogRetentionValue = number | "forever";

/** What the Settings select offers; the default (30) is a real choice here. */
export type LogRetentionChoice = LogRetentionValue;

export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** The message `setLogRetention` rejects with when the stored retention is not the one the caller saw. */
export const LOG_RETENTION_CHANGED_MESSAGE = "log-retention-changed";

/** The select's standard choices; a stored day count outside them is offered as an extra option. */
export const LOG_RETENTION_PRESET_DAYS: readonly number[] = [30, 90, 180, 365];

export function isRetentionDayCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Days to keep, or null for "keep forever". */
export function resolveLogRetentionDays(settings: { logRetentionDays?: LogRetentionValue }): number | null {
	const stored = settings.logRetentionDays;
	if (stored === "forever") return null;
	return isRetentionDayCount(stored) ? stored : DEFAULT_LOG_RETENTION_DAYS;
}

/** The select's value for a retention: the stored field, with the default made explicit. */
export function logRetentionChoice(settings: { logRetentionDays?: LogRetentionValue }): LogRetentionChoice {
	const stored = settings.logRetentionDays;
	return stored === "forever" || isRetentionDayCount(stored) ? stored : DEFAULT_LOG_RETENTION_DAYS;
}

/** The field to store for a choice; the default is stored as absent. */
export function storedLogRetention(choice: LogRetentionChoice): LogRetentionValue | undefined {
	return choice === DEFAULT_LOG_RETENTION_DAYS ? undefined : choice;
}

/** Keeps a positive day count or "forever"; 30 and anything else mean "default". */
export function sanitizeLogRetention(value: unknown): LogRetentionValue | undefined {
	if (value === "forever") return value;
	return isRetentionDayCount(value) && value !== DEFAULT_LOG_RETENTION_DAYS ? value : undefined;
}

/** True when `next` keeps strictly less history than `prev` (null = forever). */
export function isShorterRetention(prev: number | null, next: number | null): boolean {
	if (next === null) return false;
	return prev === null || next < prev;
}

/**
 * The oldest local day (as a timestamp) a retention of `retentionDays` keeps:
 * today counts as day one, so 30 days keeps today and the 29 before it. Built
 * from calendar fields, so a DST change inside the window cannot shift it by an hour.
 */
export function retentionCutoff(now: Date, retentionDays: number): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retentionDays - 1)).getTime();
}

/** One day's on-disk footprint, the sum of both logs across all projects. */
export interface LogRetentionUsageDay {
	/** Local day, `YYYY-MM-DD`. */
	day: string;
	bytes: number;
}

export interface LogRetentionUsage {
	days: LogRetentionUsageDay[];
	/** Present when the caller named a retention: what that retention would delete, by the host's clock. */
	beyond?: { days: number; bytes: number };
}

/** The days a retention of `retentionDays` would delete, and what they weigh. */
export function logUsageBeyondRetention(
	days: readonly LogRetentionUsageDay[],
	retentionDays: number,
	now: Date = new Date(),
): { days: number; bytes: number } {
	const cutoff = retentionCutoff(now, retentionDays);
	if (!Number.isFinite(cutoff)) return { days: 0, bytes: 0 }; // Same rule as the prune.
	let count = 0;
	let bytes = 0;
	for (const entry of days) {
		const [year, month, day] = entry.day.split("-").map(Number);
		if (new Date(year, month - 1, day).getTime() >= cutoff) continue;
		count += 1;
		bytes += entry.bytes;
	}
	return { days: count, bytes };
}
