import type { GlobalSettings } from "./types/global-settings";
import type { TaskStatus } from "./types/task-status";

/** Moves into these columns can chime; every other status move is silent. */
export type TaskSoundStatus = "completed" | "cancelled" | "review-by-user" | "user-questions";

/** Both columns mean the agent stopped and the ball is on the user's side. */
const NEEDS_YOU_STATUSES: ReadonlySet<TaskStatus> = new Set(["review-by-user", "user-questions"]);

export function isTaskSoundStatus(status: TaskStatus): status is TaskSoundStatus {
	return status === "completed" || status === "cancelled" || NEEDS_YOU_STATUSES.has(status);
}

export function isNeedsYouSoundStatus(status: TaskStatus): boolean {
	return NEEDS_YOU_STATUSES.has(status);
}

/** One toggle per sound family, both on unless an explicit `false`. */
export function isTaskSoundEnabled(
	settings: Pick<GlobalSettings, "playSoundOnTaskComplete" | "playSoundOnTaskNeedsYou">,
	status: TaskSoundStatus,
): boolean {
	return isNeedsYouSoundStatus(status)
		? settings.playSoundOnTaskNeedsYou !== false
		: settings.playSoundOnTaskComplete !== false;
}
