import type { TaskStatus } from "./types";

/** The approvals that destroy a worktree, and the status each one moves to. */
export type DestructiveApprovalKind = "complete" | "cancel" | "reset";

export const DESTRUCTIVE_APPROVAL_TARGET: Record<DestructiveApprovalKind, TaskStatus> = {
	complete: "completed",
	cancel: "cancelled",
	reset: "todo",
};

/**
 * The app's own answer to "what happened to that approval request?" — asked by
 * `approval.status`, and returned by an attach-only request that found nothing
 * to join. `none` means the app holds no record: it restarted, the record aged
 * out, or the request never arrived. It is NOT evidence of a decline, and
 * `taskStatus` is the only thing that says whether the move happened anyway.
 */
export interface AgentApprovalStatus {
	kind: DestructiveApprovalKind;
	state: "pending" | "answered" | "none";
	/** Present only when `state` is `answered`. */
	approved?: boolean;
	taskStatus: TaskStatus;
	/** Present when `answered`: the request was voided because its run ended — nobody answered it. */
	stale?: boolean;
	/** `reset` only: whether the task still has a run to reset. */
	resetNeeded?: boolean;
}

/** Wire shape of an attach-only request that had no live request to join. */
export interface AgentApprovalNotAttached {
	attached: false;
	status: AgentApprovalStatus;
}

export function isAgentApprovalNotAttached(data: unknown): data is AgentApprovalNotAttached {
	return typeof data === "object" && data !== null && (data as { attached?: unknown }).attached === false;
}
