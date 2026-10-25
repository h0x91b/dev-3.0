import { FOCUS_HOUR_MS, type Task } from "../../shared/types";

/** Less than a minute of on-screen time in an hour is a glance, not work. */
const MIN_FOCUS_MS_PER_HOUR = 60_000;

/**
 * When a task last saw deliberate work, in epoch ms: created, (re)started,
 * finished, or actually looked at by the user. Deliberately NOT `updatedAt`
 * (runtime/polling writes churn it) and NOT a live task's `movedAt` — hooks
 * flip in-progress ↔ review on every agent turn, so one broadcast message to
 * forgotten agents would make every dormant project look busy today.
 */
export function taskLastActivityMs(task: Task): number {
	const stamps = [task.createdAt, task.lifecycleStartedAt];
	if (task.status === "completed" || task.status === "cancelled") stamps.push(task.movedAt);
	const candidates = stamps.map((iso) => (iso ? Date.parse(iso) : NaN));
	for (const [hour, ms] of Object.entries(task.focusByHour ?? {})) {
		if (ms >= MIN_FOCUS_MS_PER_HOUR) candidates.push(Number(hour) * FOCUS_HOUR_MS);
	}
	return Math.max(0, ...candidates.filter(Number.isFinite));
}

/** A project's most recent task activity; 0 = no task ever. */
export function projectLastActivityMs(tasks: Task[]): number {
	let latest = 0;
	for (const task of tasks) latest = Math.max(latest, taskLastActivityMs(task));
	return latest;
}

/**
 * Most recently active first. Ties and never-active projects (0 / unknown) keep
 * the incoming order — `Array.prototype.sort` is stable — so the result is
 * deterministic and a project with no tasks falls back to its board position.
 */
export function orderByRecentActivity<T extends { id: string }>(projects: T[], activity: Record<string, number>): T[] {
	return [...projects].sort((a, b) => (activity[b.id] ?? 0) - (activity[a.id] ?? 0));
}
