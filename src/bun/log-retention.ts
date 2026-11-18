import type { Project } from "../shared/types";
import { logUsageBeyondRetention, type LogRetentionUsage } from "../shared/log-retention";
import { messageLogDir, pruneAgentMessageLog } from "./agent-message-log";
import { statDayFiles } from "./log-day-files";
import { notificationLogDir, pruneNotificationLog } from "./notification-log";

/**
 * On-disk bytes per day, summed over the notification log and every project's
 * message log. Stat only. With `retentionDays`, also what that retention would delete.
 */
export function collectLogRetentionUsage(
	projects: readonly Project[],
	retentionDays?: number,
	now: Date = new Date(),
): LogRetentionUsage {
	const bytesByDay = new Map<string, number>();
	const add = (entries: Array<{ day: string; bytes: number }>) => {
		for (const { day, bytes } of entries) bytesByDay.set(day, (bytesByDay.get(day) ?? 0) + bytes);
	};
	add(statDayFiles(notificationLogDir()));
	for (const project of projects) add(statDayFiles(messageLogDir(project)));
	const days = [...bytesByDay].map(([day, bytes]) => ({ day, bytes })).sort((a, b) => a.day.localeCompare(b.day));
	return retentionDays === undefined ? { days } : { days, beyond: logUsageBeyondRetention(days, retentionDays, now) };
}

/** Prune the notification log and every project's message log with the given retention now. */
export function pruneAllLogs(projects: readonly Project[], retentionDays: number | null, now: Date = new Date()): void {
	pruneNotificationLog(retentionDays, now);
	for (const project of projects) pruneAgentMessageLog(project, retentionDays, now);
}
