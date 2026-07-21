import type { Task } from "../../shared/types";

/**
 * Abort signal that fires when a task's "Branch Merged" completion prompt is
 * resolved somewhere other than this dialog — a second window, or the remote
 * browser served by the same app. The backend broadcasts the merge prompt to
 * every connected client, so without this a dialog left open on one client
 * lingers after the prompt is handled on another.
 *
 * Two triggers:
 *  - `rpc:taskUpdated` dropping the task's worktree or moving it to a terminal
 *    status — covers "accepted elsewhere" (the task is completed).
 *  - `rpc:mergePromptResolved` for this task — covers "declined elsewhere".
 *
 * Wire the returned `signal` into `confirm()` and, after awaiting, check
 * `signal.aborted` to skip this client's own resolution side effects.
 */
export function createMergePromptAbort(taskId: string): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();

	const onTaskUpdated = (e: Event) => {
		const task = (e as CustomEvent).detail?.task as Task | undefined;
		if (task?.id !== taskId) return;
		// A branch-merged prompt only makes sense while the task still has a live
		// worktree in a review state; either gone means it was resolved.
		if (!task.worktreePath || task.status === "completed" || task.status === "cancelled") {
			controller.abort();
		}
	};
	const onResolved = (e: Event) => {
		if ((e as CustomEvent).detail?.taskId === taskId) controller.abort();
	};

	window.addEventListener("rpc:taskUpdated", onTaskUpdated);
	window.addEventListener("rpc:mergePromptResolved", onResolved);

	return {
		signal: controller.signal,
		cleanup: () => {
			window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
			window.removeEventListener("rpc:mergePromptResolved", onResolved);
		},
	};
}
