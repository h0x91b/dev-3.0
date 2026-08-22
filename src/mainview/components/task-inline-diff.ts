import { resolveTaskCompareBaseBranch, type Project, type Task, type TaskDiffMode } from "../../shared/types";
import { useCallback, type Dispatch } from "react";
import { routeDiffRequest, type AppAction, type Route } from "../state";

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
		compareLabel: compareRef || project.defaultCompareRef || baseBranch,
		focusFirstUnresolvedThread: true,
	};
}

/**
 * The diff's open/closed state lives on the route, not in component state, so
 * opening it is a real navigation step: Back returns to the task and Forward
 * returns to the diff. Switching tasks drops the diff for free — the new route
 * simply carries none.
 */
export function useTaskInlineDiffState(route: Route, dispatch: Dispatch<AppAction>) {
	const request = routeDiffRequest(route);

	const open = useCallback((nextRequest: TaskInlineDiffRequest) => {
		dispatch({ type: "openTaskDiff", request: nextRequest });
	}, [dispatch]);

	const close = useCallback(() => {
		dispatch({ type: "closeTaskDiff" });
	}, [dispatch]);

	return {
		request,
		isOpen: request !== null,
		open,
		close,
	};
}
