import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { activeNotificationSuppression } from "../rpc-handlers";
import { appendNotificationLog } from "../notification-log";
import type { NotificationLogInput, NotificationLogMode, NotificationLogOutcome } from "../../shared/notification-log";
import { resolveTaskAcrossProjects } from "./task-resolution";

/** Everything a notification row knows before the app tries to deliver it. */
type NotificationLogBase = Omit<NotificationLogInput, "at" | "mode" | "outcome" | "suppressedBy">;

/**
 * Collect the facts a notification row is made of. The caller's worktree
 * (`sourceTaskId`) is resolved separately from the notification's target,
 * because `dev3 notify --task <other>` addresses someone else's card; when the
 * caller was not in a worktree the source stays null rather than borrowing the
 * target's identity.
 */
export async function buildNotificationLogBase(
	params: Record<string, unknown>,
	notification: {
		message: string;
		level: "info" | "success" | "error";
		durationMs: unknown;
		task: Task | null;
		projectId: string | null;
		projectName: string | null;
	},
): Promise<NotificationLogBase> {
	const { message, level, durationMs, task, projectId, projectName } = notification;
	const base: NotificationLogBase = {
		level,
		message,
		taskId: task?.id ?? null,
		taskSeq: task?.seq ?? null,
		projectId,
		sourceTaskId: null,
		sourceSeq: null,
	};
	if (typeof durationMs === "number") base.durationMs = durationMs;
	if (task) base.taskTitle = getTaskTitle(task);
	if (projectName) base.projectName = projectName;
	const sessionId = typeof params.sourceSessionId === "string" ? params.sourceSessionId.trim() : "";
	if (sessionId) base.sourceSessionId = sessionId;

	const sourceTaskId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
	if (!sourceTaskId) return base;
	try {
		const found = await resolveTaskAcrossProjects(sourceTaskId);
		if (found) {
			base.sourceTaskId = found.task.id;
			base.sourceSeq = found.task.seq;
			base.sourceTitle = getTaskTitle(found.task);
			base.sourceProjectId = found.task.projectId;
		}
	} catch {
		// An ambiguous or stale sender ref is not knowledge — the source stays null.
	}
	return base;
}

/**
 * Write one notification row, unless this delivery is the CLI's fan-out copy.
 *
 * `dev3 notify` sends the same toast to every live dev3 instance so it reaches
 * whichever app the user is looking at. That is one notification, not N, so only
 * the instance the CLI addressed first records it.
 */
export function recordNotification(
	params: Record<string, unknown>,
	base: NotificationLogBase,
	mode: NotificationLogMode,
	outcome: NotificationLogOutcome,
): void {
	if (params.fanout === true) return;
	const suppressedBy = outcome === "queued" ? activeNotificationSuppression() : [];
	appendNotificationLog({
		...base,
		at: new Date().toISOString(),
		mode,
		outcome,
		...(suppressedBy.length ? { suppressedBy } : {}),
	});
}
