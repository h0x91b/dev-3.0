import type { Task } from "./task";

/**
 * Minimum length of a short ID prefix (task/project/label/note) accepted for
 * prefix matching. Below this, a prefix is treated as "not a prefix" (too broad
 * to disambiguate) rather than resolved to whichever entity happens to match
 * first. Single source of truth: the CLI-side resolver (`expandShortId`) and the
 * server-side `findByIdPrefix` MUST use the same threshold, or a short prefix the
 * CLI silently expands would bypass the server's own guard. See decision 102.
 */
export const ID_PREFIX_MIN_LENGTH = 8;

// ---- Data models ----

export type TaskStatus =
	| "todo"
	| "in-progress"
	| "user-questions"
	| "review-by-ai"
	| "review-by-user"
	| "review-by-colleague"
	| "completed"
	| "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = [
	"in-progress",
	"user-questions",
	"review-by-user",
	"review-by-colleague",
	"review-by-ai",
];

/**
 * Rejection message every activation path produces for a draft task. The CLI
 * compares against it to translate the lifecycle rejection into its dedicated
 * exit code, so the string is a contract — not free-form log text.
 */
export const DRAFT_TASK_ACTIVATION_ERROR =
	"Task is a draft — finish its description and save it as a normal task before starting it.";

/**
 * Rejection message every column change on a hibernated task produces. Like
 * {@link DRAFT_TASK_ACTIVATION_ERROR} this string is a contract, not log text.
 */
export const HIBERNATED_TASK_MOVE_ERROR =
	"Task is hibernated — wake it from its terminal before moving it to another column.";

/**
 * Moving a running task back to To Do resets it: the agent is stopped and the
 * worktree and dev3 branch are deleted. Only an explicit, confirmed reset does
 * that; a plain move (board drag, hook, `force` retry) is refused with this.
 */
export const RESET_REQUIRES_CONSENT_ERROR =
	"Moving this task to To Do resets it — it stops the agent and deletes the worktree. Confirm the reset to do that.";

/** A To Do card still owning a worktree from an earlier run is never re-initialised silently. */
export const TODO_OWNS_WORKTREE_ERROR =
	"This To Do task still owns a worktree from an earlier run. Reset it before starting it again.";

/** A To Do task starts only from an explicit launch — never from an agent hook. */
export const LAUNCH_REQUIRES_EXPLICIT_START_ERROR =
	"A To Do task can only be started explicitly (Start / Run, or `dev3 task move` from outside the task).";

/** The run the user agreed to reset is no longer the task's current run. */
export const RESET_CONSENT_STALE_ERROR =
	"The task changed since the reset was confirmed — nothing was deleted. Confirm the reset again if you still want it.";

/** Reset refuses to race the app's own preparation or teardown. */
export const RESET_BUSY_ERROR =
	"Task is still starting up or shutting down — try resetting it once it settles.";

/**
 * Does moving this task to To Do destroy anything? True for a task in an active
 * column (it owns a session) or one that still owns a worktree. False for a
 * clean To Do card, a draft, and completed/cancelled tasks — those moves stay
 * plain and non-destructive.
 */
export function taskNeedsReset(task: Pick<Task, "status" | "worktreePath">): boolean {
	if (task.status === "completed" || task.status === "cancelled") return false;
	return ACTIVE_STATUSES.includes(task.status) || !!task.worktreePath;
}

/**
 * What the user agreed to destroy, captured when the reset dialog opened: this
 * worktree, in this run. `lifecycleStartedAt` is stamped on entering
 * `in-progress` and cleared by a reset, so a relaunch at the same path no
 * longer matches. `null` means the run carried no stamp.
 */
export type WorktreeAccessState = "present" | "missing" | "unreadable";

/** A branch a reset left in place, and why — the user is told, never left to discover it. */
export interface ResetKeptBranch {
	name: string;
	reason: "not-owned" | "variant-unproven" | "unique-commits" | "note-failed" | "delete-failed";
}

export interface TaskResetResult {
	task: Task;
	keptBranches: ResetKeptBranch[];
}

export interface TaskResetConsent {
	worktreePath: string | null;
	lifecycleStartedAt: string | null;
}

type ResetConsentFields = { worktreePath?: string | null; lifecycleStartedAt?: string | null };

export function taskResetConsent(task: ResetConsentFields): TaskResetConsent {
	return { worktreePath: task.worktreePath ?? null, lifecycleStartedAt: task.lifecycleStartedAt ?? null };
}

export function taskResetConsentMatches(task: ResetConsentFields, consent: TaskResetConsent): boolean {
	return (task.worktreePath ?? null) === consent.worktreePath
		&& (task.lifecycleStartedAt ?? null) === consent.lifecycleStartedAt;
}

/**
 * Prefix on every "could not work out what this task is about" rejection from
 * `task.create` — an unresolvable `--pr` or `--branch`. The CLI strips it and
 * exits with its own code, so like {@link DRAFT_TASK_ACTIVATION_ERROR} the
 * string is a contract.
 */
export const TASK_REF_UNRESOLVED_PREFIX = "task-ref-unresolved: ";

export const MERGE_COMPLETE_ELIGIBLE_STATUSES: TaskStatus[] = [
	"user-questions",
	"review-by-user",
	"review-by-colleague",
];

export const ALL_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
	"review-by-colleague",
	"completed",
	"cancelled",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "Agent is Working",
	"user-questions": "Has Questions",
	"review-by-ai": "AI Review",
	"review-by-user": "Your Review",
	"review-by-colleague": "PR Review",
	completed: "Completed",
	cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
	todo: "#70e3ff",
	"in-progress": "#afbaff",
	"user-questions": "#ffa353",
	"review-by-ai": "#a0aec0",
	"review-by-user": "#ffe55f",
	"review-by-colleague": "#c4a5ff",
	completed: "#3cf3b0",
	cancelled: "#ff8282",
};

/** Light-theme column colours. Every one sits at the sRGB chroma ceiling for its
 *  lightness, and the hues are spaced (15° → 40° → 95° → 152° → 232° → 272° →
 *  318°) so that a column stays recognisable after the glow overlay keeps only a
 *  fraction of its chroma. `review-by-ai` is deliberately the neutral one.
 *
 *  These values are optimised for use as **glow, dot, and border identity** —
 *  NOT as text ink. For rendered text use STATUS_COLORS_LIGHT_INK instead. */
export const STATUS_COLORS_LIGHT: Record<TaskStatus, string> = {
	todo: "#0182b0",
	"in-progress": "#4b59ff",
	"user-questions": "#d04801",
	"review-by-ai": "#656971",
	"review-by-user": "#9e8401",
	"review-by-colleague": "#b702df",
	completed: "#04944b",
	cancelled: "#d20346",
};

/** Light-theme ink colours for column header badges/chips where the status
 *  colour is rendered as text. Verified to clear APCA |Lc| ≥ 60 on the
 *  composited glass column header surface; hues match STATUS_COLORS_LIGHT but
 *  are darkened where the standard value falls below the floor. */
export const STATUS_COLORS_LIGHT_INK: Record<TaskStatus, string> = {
	todo: "#01699e",           // darkened (standard: #0182b0, Lc ~57)
	"in-progress": "#4b59ff",  // passes as-is (Lc ~63)
	"user-questions": "#a63801", // darkened (standard: #d04801, Lc ~59)
	"review-by-ai": "#656971",   // passes as-is (Lc ~71)
	"review-by-user": "#736000", // darkened (standard: #9e8401, Lc ~50)
	"review-by-colleague": "#b702df", // passes as-is (Lc ~68)
	completed: "#06723a",      // darkened (standard: #04944b, Lc ~60)
	cancelled: "#d20346",      // passes as-is (Lc ~71)
};

/** Convert "#rrggbb" → "R G B" for use as CSS variable value */
export function hexToRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `${r} ${g} ${b}`;
}

/** Returns the list of statuses a task can transition to from `current`. */
export function getAllowedTransitions(current: TaskStatus): TaskStatus[] {
	if (current === "todo") {
		return ["in-progress", "completed", "cancelled"];
	}
	return ALL_STATUSES.filter((s) => s !== current);
}

// Conditional-move guards (--if-status / --if-status-not). Returns true when a
// move should be blocked given the task's current status. This is the single
// source of truth, used both by the authoritative in-lock check in data.ts and
// by pre-checks at call sites that must avoid side effects (worktree/PTY) when a
// guarded move is blocked.
export function isStatusGuardBlocked(
	status: string,
	options?: { ifStatus?: string; ifStatusNot?: string },
): boolean {
	const allowedStatuses = options?.ifStatus
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (allowedStatuses && !allowedStatuses.includes(status)) {
		return true;
	}
	const blockedStatuses = options?.ifStatusNot
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (blockedStatuses && blockedStatuses.includes(status)) {
		return true;
	}
	return false;
}
