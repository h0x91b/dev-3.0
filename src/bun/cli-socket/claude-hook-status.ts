import { CLAUDE_TOOL_STATUS_EVENTS, type ClaudeToolStatusEvent } from "../../shared/claude-status-hook";
import { claudeApprovals } from "../claude-approval-state";
import { moveTask } from "../rpc-handlers";
import type { Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

export const applyClaudeHookStatus: Handler = (params) => claudeApprovals.run(String(params.taskId), async () => {
	const event = params.event as ClaudeToolStatusEvent | "UserPromptSubmit";
	if (event !== "UserPromptSubmit" && !CLAUDE_TOOL_STATUS_EVENTS.includes(event)) throw new Error("Unsupported Claude status event");
	const { task } = await resolveTaskFromParams(params);
	const target = claudeApprovals.apply(task.id, task.status, event, {
		sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
		agentId: typeof params.agentId === "string" && params.agentId ? params.agentId : undefined,
	});
	if (!target || (target === task.status && task.customColumnId == null)) return task;
	return moveTask({
		taskId: task.id,
		projectId: task.projectId,
		newStatus: target,
		ifStatus: task.status,
	});
});
