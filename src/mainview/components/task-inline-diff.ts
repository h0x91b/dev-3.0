import { resolveTaskCompareBaseBranch, type Project, type Task, type TaskDiffMode } from "../../shared/types";
import { useCallback, useEffect, useState } from "react";

export interface TaskInlineDiffRequest {
	mode: TaskDiffMode;
	compareRef?: string;
	compareLabel?: string;
	focusFile?: string;
	/** Scroll to the first unresolved GitHub review thread once the branch diff
	 * and the PR comment payload have both loaded (PR status popover deep link). */
	focusFirstUnresolvedThread?: boolean;
}

/** Build the branch-diff request used by PR popover unresolved-comment links. */
export function createUnresolvedCommentsDiffRequest(
	task: Pick<Task, "baseBranch" | "branchName">,
	project: Pick<Project, "defaultBaseBranch" | "defaultCompareRef" | "defaultCompareRefMode">,
): TaskInlineDiffRequest {
	const baseBranch = resolveTaskCompareBaseBranch(task, project);
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const compareRef = baseBranch !== projectBaseBranch
		? baseBranch
		: project.defaultCompareRef || (project.defaultCompareRefMode === "local" ? baseBranch : undefined);

	return {
		mode: "branch",
		compareRef,
		compareLabel: compareRef || `origin/${baseBranch}`,
		focusFirstUnresolvedThread: true,
	};
}

export function useTaskInlineDiffState(taskId?: string) {
	const [request, setRequest] = useState<TaskInlineDiffRequest | null>(null);

	useEffect(() => {
		setRequest(null);
	}, [taskId]);

	const open = useCallback((nextRequest: TaskInlineDiffRequest) => {
		setRequest(nextRequest);
	}, []);

	const close = useCallback(() => {
		setRequest(null);
	}, []);

	return {
		request,
		isOpen: request !== null,
		open,
		close,
	};
}
