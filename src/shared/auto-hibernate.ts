import type { Task } from "./types";

export const DEFAULT_AUTO_HIBERNATE_MINUTES = 60;
export const MAX_AUTO_HIBERNATE_MINUTES = 43_200;

/** Zero means disabled; malformed values never opt an installation in. */
export function normalizeAutoHibernateMinutes(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUTO_HIBERNATE_MINUTES
		? value : 0;
}

export function canAutoHibernate(task: Task): boolean {
	return !!task.worktreePath && !task.hibernated && !task.draft && !task.preparing
		&& !task.keepAlive?.enabled && task.customColumnId == null
		&& (task.status === "user-questions" || task.status === "review-by-user" || task.status === "review-by-colleague")
		&& (!task.runtimeState || task.runtimeState.runtime === "running");
}

/** Metadata refreshes also write updatedAt; only lifecycle changes restart idleness. */
export function taskInactivityStateAt(task: Task): number {
	return Math.max(Date.parse(task.movedAt ?? task.createdAt) || 0, task.runtimeState?.updatedAt ?? 0);
}

export function autoHibernateStillIdle(task: Task, lastActivityAt: number, timeoutMinutes: number, configured: unknown, activityAt: number, now: number): boolean {
	return normalizeAutoHibernateMinutes(configured) === timeoutMinutes && timeoutMinutes > 0
		&& canAutoHibernate(task) && activityAt <= lastActivityAt
		&& taskInactivityStateAt(task) <= lastActivityAt && now - lastActivityAt >= timeoutMinutes * 60_000;
}
