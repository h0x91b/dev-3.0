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

/**
 * The completion chime is opt-out (on unless an explicit `false`); each
 * needs-you column has its own opt-in toggle (off unless an explicit `true`).
 */
export function isTaskSoundEnabled(
	settings: Pick<GlobalSettings, "playSoundOnTaskComplete" | "playSoundOnTaskQuestions" | "playSoundOnTaskReview">,
	status: TaskSoundStatus,
): boolean {
	if (status === "user-questions") return settings.playSoundOnTaskQuestions === true;
	if (status === "review-by-user") return settings.playSoundOnTaskReview === true;
	return settings.playSoundOnTaskComplete !== false;
}

/**
 * The two needs-you toggles split the legacy `playSoundOnTaskNeedsYou`, which seeds
 * any toggle not yet stored as a boolean. Older builds read only the legacy key.
 */
export function resolveNeedsYouSoundToggles(
	d: Record<string, unknown>,
): Pick<GlobalSettings, "playSoundOnTaskQuestions" | "playSoundOnTaskReview"> {
	const legacy = d.playSoundOnTaskNeedsYou === true ? true : undefined;
	return {
		playSoundOnTaskQuestions: typeof d.playSoundOnTaskQuestions === "boolean" ? d.playSoundOnTaskQuestions : legacy,
		playSoundOnTaskReview: typeof d.playSoundOnTaskReview === "boolean" ? d.playSoundOnTaskReview : legacy,
	};
}
