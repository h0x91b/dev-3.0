import type { Dispatch } from "react";
import { api } from "../rpc";
import { toast } from "../toast";
import { trackEvent, agentNameFromId } from "../analytics";
import posthog from "../posthog";
import { confirmTaskCompletion } from "./confirmTaskCompletion";
import { confirmTaskReset } from "./confirmTaskReset";
import { playTaskCompletionSound } from "../task-sounds";
import { ACTIVE_STATUSES, taskNeedsReset, type Task, type Project, type TaskStatus } from "../../shared/types";

/**
 * Starting a To Do card is a launch (agent + variant picker), never a bare column
 * move: the lifecycle refuses a start without an explicit launch. Surfaces that
 * only know "move to status" hand the launch to the app-level launch modal.
 */
export const LAUNCH_REQUESTED_EVENT = "dev3:launchRequested";
export interface LaunchRequestedDetail {
	task: Task;
	project: Project;
	targetStatus: TaskStatus;
}
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
	/** Open the task from the terminal-state confirmation card. */
	onOpenTask?: () => void;
	/** Run the unpushed/uncommitted confirmation before terminal moves. Default true. */
	confirm?: boolean;
	/**
	 * Always show the terminal-move dialog, even with a clean branch or no
	 * worktree. Set by one-click affordances (the card's quick-complete ✓) where
	 * a mis-click must not silently complete a task.
	 */
	alwaysConfirm?: boolean;
	/** Toggle a per-card "moving" spinner while the background RPC is in flight. */
	onMovingChange?: (moving: boolean) => void;
	/** Run right after the optimistic update commits (e.g. navigate away from the task screen). */
	afterOptimistic?: () => void;
	/** Run only after the server confirms the move (after both RPC attempts succeed). Not called on failure. */
	onSuccess?: () => void;
	/**
	 * Run when both RPC attempts failed. For surfaces holding their own list of
	 * tasks (the dashboard's activity rows), this is where a locally-dropped row
	 * comes back — `dispatch` only reverts the shared task state.
	 */
	onFailure?: (err: unknown) => void;
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

type ResetOptions = Pick<MoveTaskToStatusOptions,
	"task" | "project" | "dispatch" | "t" | "onOpenTask" | "onMovingChange" | "afterOptimistic" | "onSuccess" | "onFailure" | "revertOnFailure">;

/**
 * Confirm, then reset: decline changes nothing (no optimistic update, no RPC).
 * Exported for the launch paths that meet a To Do card still owning a worktree.
 */
export async function resetTaskToTodoWithConsent({
	task,
	project,
	dispatch,
	t,
	onOpenTask,
	onMovingChange,
	afterOptimistic,
	onSuccess,
	onFailure,
	revertOnFailure = true,
}: ResetOptions): Promise<"declined" | "reset" | "failed"> {
	const consent = await confirmTaskReset(task, project, t, onOpenTask);
	if (!consent) return "declined";
	const movedNow = new Date().toISOString();
	dispatch({
		type: "updateTask",
		task: { ...task, status: "todo", customColumnId: null, movedAt: movedNow, statusEnteredAt: movedNow },
	});
	dispatch({ type: "clearBell", taskId: task.id });
	afterOptimistic?.();
	onMovingChange?.(true);
	try {
		const { task: updated, keptBranches } = await api.request.resetTaskToTodo({ taskId: task.id, projectId: project.id, consent });
		dispatch({ type: "updateTask", task: updated });
		if (keptBranches.length > 0) {
			toast.info(t("task.resetKeptBranches", { branches: keptBranches.map((branch) => branch.name).join(", ") }), { taskId: task.id });
		}
		trackEvent("task_moved", { from_status: task.status, to_status: "todo", agent_name: agentNameFromId(task.agentId) });
		posthog.capture("task_moved", { from_status: task.status, to_status: "todo" });
		onSuccess?.();
		return "reset";
	} catch (err) {
		onFailure?.(err);
		if (revertOnFailure) dispatch({ type: "updateTask", task });
		toast.error(t("task.resetFailed", { error: String(err) }), { taskId: task.id });
		return "failed";
	} finally {
		onMovingChange?.(false);
	}
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
	onOpenTask,
	confirm = true,
	alwaysConfirm = false,
	onMovingChange,
	afterOptimistic,
	onSuccess,
	onFailure,
	revertOnFailure = true,
}: MoveTaskToStatusOptions): Promise<boolean> {
	const terminal = isTerminalStatus(newStatus);

	// To Do on a task with a run is a reset: a separate, always-confirmed path with
	// no force retry — `force` must never turn a refused reset into a destructive one.
	if (newStatus === "todo" && taskNeedsReset(task)) {
		const outcome = await resetTaskToTodoWithConsent({ task, project, dispatch, t, onOpenTask, onMovingChange, afterOptimistic, onSuccess, onFailure, revertOnFailure });
		return outcome !== "declined";
	}

	if (task.status === "todo" && ACTIVE_STATUSES.includes(newStatus)) {
		// A card still owning a worktree from an earlier run is reset first.
		let launchTask = task;
		if (task.worktreePath) {
			const outcome = await resetTaskToTodoWithConsent({ task, project, dispatch, t, onOpenTask });
			if (outcome !== "reset") return false;
			launchTask = { ...task, worktreePath: null, branchName: null };
		}
		window.dispatchEvent(new CustomEvent<LaunchRequestedDetail>(LAUNCH_REQUESTED_EVENT, {
			detail: { task: launchTask, project, targetStatus: newStatus },
		}));
		return true;
	}

	if (confirm && terminal && (task.worktreePath || alwaysConfirm)) {
		const proceed = await confirmTaskCompletion(task, project, newStatus, t, onOpenTask, { alwaysConfirm });
		if (!proceed) return false;
	}

	const fromStatus = task.status;

	// Optimistic update mirroring the server's end-state so the card doesn't
	// flicker when the real task comes back. `statusEnteredAt` is stamped on every
	// move, not just terminal ones: it is what both the board and the sidebar sort
	// by, so without it the card would sit in its old slot until the RPC returns.
	const movedNow = new Date().toISOString();
	const optimisticTask: Task = terminal
		? {
			...task,
			status: newStatus,
			worktreePath: null,
			branchName: null,
			customColumnId: null,
			movedAt: movedNow,
			statusEnteredAt: movedNow,
		}
		: { ...task, status: newStatus, customColumnId: null, movedAt: movedNow, statusEnteredAt: movedNow };
	dispatch({ type: "updateTask", task: optimisticTask });
	// When the UI plays the completion sound here, tell the backend to skip its
	// own `taskSound` push — otherwise it comes back to a window and to every
	// attached remote browser, and the chime plays twice.
	let clientPlayedSound = false;
	if (terminal) {
		dispatch({ type: "clearBell", taskId: task.id });
		clientPlayedSound = playTaskCompletionSound(newStatus as "completed" | "cancelled");
	}
	afterOptimistic?.();

	onMovingChange?.(true);
	try {
		let updated: Task;
		try {
			updated = await api.request.moveTask({ taskId: task.id, projectId: project.id, newStatus, clientPlayedSound });
		} catch {
			// Environment is likely broken (missing worktree, etc.) — force it through.
			updated = await api.request.moveTask({ taskId: task.id, projectId: project.id, newStatus, force: true, clientPlayedSound });
		}
		dispatch({ type: "updateTask", task: updated });
		trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus, agent_name: agentNameFromId(task.agentId) });
		posthog.capture("task_moved", { from_status: fromStatus, to_status: newStatus });
		onSuccess?.();
	} catch (err) {
		onFailure?.(err);
		if (revertOnFailure) {
			dispatch({ type: "updateTask", task });
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		} else {
			console.error("moveTaskToStatus failed:", err);
		}
	} finally {
		onMovingChange?.(false);
	}
	return true;
}
