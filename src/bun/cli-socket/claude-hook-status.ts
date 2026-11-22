import { CLAUDE_TOOL_STATUS_EVENTS, type ClaudeToolStatusEvent } from "../../shared/claude-status-hook";
import { claudeApprovals } from "../claude-approval-state";
import { moveTask } from "../rpc-handlers";
import { log, type Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

/**
 * Re-arm the one timer that lets a stopped parent's card leave Agent is Working when a
 * background agent's stop event never arrives. Call after every change to the task's state.
 */
export function scheduleClaudeBackgroundExpiry(taskId: string, projectId: string): void {
	const at = claudeApprovals.nextExpiry(taskId);
	if (at === null) {
		claudeApprovals.cancelExpiry(taskId);
		return;
	}
	claudeApprovals.armExpiry(taskId, Math.max(0, at - Date.now()), () => {
		void claudeApprovals.run(taskId, async () => {
			const { task } = await resolveTaskFromParams({ taskId, projectId });
			const target = claudeApprovals.expireStale(task.id, task.status);
			if (target && target !== task.status) {
				await moveTask({ taskId: task.id, projectId: task.projectId, newStatus: target, ifStatus: task.status });
			}
		}).then(
			() => scheduleClaudeBackgroundExpiry(taskId, projectId),
			(error) => {
				// A task that can no longer be resolved or moved would re-fire at once forever.
				claudeApprovals.forgetTask(taskId);
				log.warn("Claude background expiry failed; dropped the task's approval state", { taskId: taskId.slice(0, 8), error: String(error) });
			},
		);
	});
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
