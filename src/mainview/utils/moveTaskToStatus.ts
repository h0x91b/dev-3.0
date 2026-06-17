import type { Dispatch } from "react";
import { api } from "../rpc";
import { toast } from "../toast";
import { trackEvent } from "../analytics";
import { confirmTaskCompletion } from "./confirmTaskCompletion";
import { playTaskCompletionSound } from "../task-sounds";
import type { Task, Project, TaskStatus } from "../../shared/types";
import type { AppAction } from "../state";
import type { TFunction } from "../i18n";

function isTerminalStatus(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

export interface MoveTaskToStatusOptions {
	task: Task;
	project: Project;
	newStatus: TaskStatus;
	dispatch: Dispatch<AppAction>;
	t: TFunction;
	/** Run the unpushed/uncommitted confirmation before terminal moves. Default true. */
	confirm?: boolean;
	/** Toggle a per-card "moving" spinner while the background RPC is in flight. */
	onMovingChange?: (moving: boolean) => void;
	/** Record an in-session move (kanban column ordering). */
	onMoved?: () => void;
	/** Run right after the optimistic update commits (e.g. navigate away from the task screen). */
	afterOptimistic?: () => void;
	/**
	 * On total RPC failure (both the normal and forced attempts), revert the
	 * optimistic update and surface a toast. Default true.
	 *
	 * Set false for "fire-and-forget" surfaces that navigate away from the task
	 * (terminal toolbar, post-merge auto-complete): there the move is already
	 * committed in the user's mind and bouncing the card back would be jarring,
	 * so the failure is only logged.
	 */
	revertOnFailure?: boolean;
}

/**
 * Single source of truth for moving a task to a new status from the UI.
 *
 * Every surface — board drag, card status menu, info panel, detail modal,
 * terminal toolbar, auto-complete on branch merge — goes through this so the
 * behaviour is identical everywhere:
 *
 *   1. Optional confirmation for terminal moves with unsaved git state.
 *   2. Optimistic update committed on the SAME tick the user acts, mirroring the
 *      server's end-state, plus — for terminal moves — the completion sound
 *      played instantly (no waiting on the bun round-trip, which can take
 *      seconds while the worktree is cleaned up).
 *   3. Background moveTask RPC with a force-retry fallback; revert + toast on
 *      total failure.
 *
 * Returns true if the move proceeded, false if the user cancelled at the
 * confirmation step.
 */
export async function moveTaskToStatus({
	task,
	project,
	newStatus,
	dispatch,
	t,
	confirm = true,
	onMovingChange,
	onMoved,
	afterOptimistic,
	revertOnFailure = true,
}: MoveTaskToStatusOptions): Promise<boolean> {
	const terminal = isTerminalStatus(newStatus);

	if (confirm && terminal && task.worktreePath) {
		const proceed = await confirmTaskCompletion(task, project, newStatus, t);
		if (!proceed) return false;
	}

	const fromStatus = task.status;

	// Optimistic update. For terminal moves mirror the server's end-state
	// (worktree/branch cleared, movedAt stamped, column order reset) so the card
	// doesn't flicker when the real task comes back.
	const optimisticTask: Task = terminal
		? {
			...task,
			status: newStatus,
			worktreePath: null,
			branchName: null,
			customColumnId: null,
			movedAt: new Date().toISOString(),
			columnOrder: undefined,
		}
		: { ...task, status: newStatus, customColumnId: null };
	dispatch({ type: "updateTask", task: optimisticTask });
	if (terminal) {
		dispatch({ type: "clearBell", taskId: task.id });
		playTaskCompletionSound(newStatus as "completed" | "cancelled");
	}
	onMoved?.();
	trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
	afterOptimistic?.();

	onMovingChange?.(true);
	try {
		let updated: Task;
		try {
			updated = await api.request.moveTask({ taskId: task.id, projectId: project.id, newStatus });
		} catch {
			// Environment is likely broken (missing worktree, etc.) — force it through.
			updated = await api.request.moveTask({ taskId: task.id, projectId: project.id, newStatus, force: true });
		}
		dispatch({ type: "updateTask", task: updated });
	} catch (err) {
		if (revertOnFailure) {
			dispatch({ type: "updateTask", task });
			toast.error(t("task.failedMove", { error: String(err) }));
		} else {
			console.error("moveTaskToStatus failed:", err);
		}
	} finally {
		onMovingChange?.(false);
	}
	return true;
}
