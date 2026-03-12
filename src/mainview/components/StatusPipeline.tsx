import type { TaskStatus } from "../../shared/types";

/**
 * The "happy path" pipeline stages — the main linear flow a task goes through.
 * Statuses not in this list (user-questions, cancelled) are side-branches
 * shown as modifiers, not pipeline nodes.
 */
export const PIPELINE_STAGES: TaskStatus[] = [
	"todo",
	"in-progress",
	"review-by-ai",
	"review-by-user",
	"review-by-colleague",
	"completed",
];

/**
 * Returns the pipeline stage index for a given status.
 * Side-branch statuses map to their "parent" stage:
 *   user-questions → in-progress (index 1)
 *   cancelled → in-progress (index 1) — task was stopped, not completed
 */
export function getPipelineIndex(status: TaskStatus): number {
	const direct = PIPELINE_STAGES.indexOf(status);
	if (direct >= 0) return direct;
	if (status === "user-questions") return PIPELINE_STAGES.indexOf("in-progress");
	if (status === "cancelled") return PIPELINE_STAGES.indexOf("in-progress");
	return 0;
}

/**
 * Returns the state of each pipeline stage relative to the current status.
 */
export type StageState = "done" | "current" | "future";

export function getStageStates(currentStatus: TaskStatus): StageState[] {
	const currentIdx = getPipelineIndex(currentStatus);
	return PIPELINE_STAGES.map((_, i) => {
		if (i < currentIdx) return "done";
		if (i === currentIdx) return "current";
		return "future";
	});
}

/**
 * Whether the current status is a "side-branch" (not on the main pipeline line).
 */
export function isSideBranch(status: TaskStatus): boolean {
	return status === "user-questions" || status === "cancelled";
}
