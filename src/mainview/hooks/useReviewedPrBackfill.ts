import { useEffect } from "react";
import type { Task } from "../../shared/types";
import { api } from "../rpc";

const askedThisSession = new Set<string>();

/** A review task created before `reviewedPr` was stored, whose PR nobody has looked up yet. */
export function needsReviewedPrLookup(task: Task): boolean {
	return !task.reviewedPr
		&& Boolean(task.existingBranch)
		&& (task.taskType === "pr-review" || task.foreignCode === true)
		&& !askedThisSession.has(task.id);
}

/**
 * Asks the backend once per task per session to find and store the PR a legacy
 * review task reviews. The answer arrives as an ordinary `taskUpdated` push, so
 * every surface renders the same stored link; a miss simply shows no link.
 */
export function useReviewedPrBackfill(tasks: Task[]): void {
	useEffect(() => {
		for (const task of tasks) {
			if (!needsReviewedPrLookup(task)) continue;
			askedThisSession.add(task.id);
			api.request.resolveReviewedPr({ projectId: task.projectId, taskId: task.id }).catch(() => {});
		}
	}, [tasks]);
}

/** Test seam: forget which tasks were already asked about. */
export function resetReviewedPrBackfill(): void {
	askedThisSession.clear();
}
