import { CLAUDE_TOOL_STATUS_EVENTS, type ClaudeToolStatusEvent } from "../../shared/claude-status-hook";
import { claudeApprovals } from "../claude-approval-state";
import { moveTask } from "../rpc-handlers";
import { log, type Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Re-arm the one timer that lets a stopped parent's card leave Agent is Working when a
 * background agent's stop event never arrives. Call after every change to the task's state.
 */
export function scheduleClaudeBackgroundExpiry(taskId: string, projectId: string): void {
	const previous = expiryTimers.get(taskId);
	if (previous) clearTimeout(previous);
	expiryTimers.delete(taskId);
	const at = claudeApprovals.nextExpiry(taskId);
	if (at === null) return;
	const timer = setTimeout(() => {
		expiryTimers.delete(taskId);
		void claudeApprovals.run(taskId, async () => {
			const { task } = await resolveTaskFromParams({ taskId, projectId });
			const target = claudeApprovals.expireStale(task.id, task.status);
			if (target && target !== task.status) {
				await moveTask({ taskId: task.id, projectId: task.projectId, newStatus: target, ifStatus: task.status });
			}
		}).catch((error) => {
			log.warn("Claude background expiry failed", { taskId: taskId.slice(0, 8), error: String(error) });
		}).finally(() => scheduleClaudeBackgroundExpiry(taskId, projectId));
	}, Math.max(0, at - Date.now()));
	(timer as { unref?: () => void }).unref?.();
	expiryTimers.set(taskId, timer);
}

export const applyClaudeHookStatus: Handler = (params) => claudeApprovals.run(String(params.taskId), async () => {
	const event = params.event as ClaudeToolStatusEvent | "UserPromptSubmit";
	if (event !== "UserPromptSubmit" && !CLAUDE_TOOL_STATUS_EVENTS.includes(event)) throw new Error("Unsupported Claude status event");
	const { task } = await resolveTaskFromParams(params);
	try {
		const target = claudeApprovals.apply(task.id, task.status, event, {
			sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
			agentId: typeof params.agentId === "string" && params.agentId ? params.agentId : undefined,
		});
		if (!target || (target === task.status && task.customColumnId == null)) return task;
		return await moveTask({
			taskId: task.id,
			projectId: task.projectId,
			newStatus: target,
			ifStatus: task.status,
		});
	} finally {
		scheduleClaudeBackgroundExpiry(task.id, task.projectId);
	}
});
