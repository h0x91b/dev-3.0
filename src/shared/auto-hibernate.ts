import type { Task } from "./types";

export const DEFAULT_AUTO_HIBERNATE_MINUTES = 1440;
export const MAX_AUTO_HIBERNATE_MINUTES = 43_200;

export const DEFAULT_AUTO_HIBERNATE_CONFIRM_MINUTES = 30;

export interface AutoHibernateSuggestion {
	id: string;
	tasks: Array<{ taskId: string; projectId: string; title: string; projectName: string; lastActivityAt: number; timeoutMinutes: number }>;
	autoConfirmAt: number | null;
	held: boolean;
}

/** Missing values use the default; zero explicitly disables suggestions. */
export function normalizeAutoHibernateMinutes(value: unknown): number {
	if (value === undefined) return DEFAULT_AUTO_HIBERNATE_MINUTES;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUTO_HIBERNATE_MINUTES
		? value : 0;
}

export function normalizeAutoHibernateConfirmMinutes(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUTO_HIBERNATE_MINUTES
		? value : DEFAULT_AUTO_HIBERNATE_CONFIRM_MINUTES;
}

export function canAutoHibernate(task: Task): boolean {
	return !!task.worktreePath && !task.hibernated && !task.draft && !task.preparing
		&& !task.keepAlive?.enabled && task.customColumnId == null
		&& (task.status === "user-questions" || task.status === "review-by-user" || task.status === "review-by-colleague")
		&& (!task.runtimeState || task.runtimeState.runtime === "running");
}

/** Metadata refreshes also write updatedAt; only lifecycle changes restart idleness. */
export function taskInactivityStateAt(task: Task): number {
	return Date.parse(task.movedAt ?? task.createdAt) || 0;
}

export function autoHibernateStillIdle(task: Task, lastActivityAt: number, timeoutMinutes: number, configured: unknown, activityAt: number, now: number): boolean {
	return normalizeAutoHibernateMinutes(configured) === timeoutMinutes && timeoutMinutes > 0
		&& canAutoHibernate(task) && activityAt <= lastActivityAt
		&& taskInactivityStateAt(task) <= lastActivityAt && now - lastActivityAt >= timeoutMinutes * 60_000;
}
