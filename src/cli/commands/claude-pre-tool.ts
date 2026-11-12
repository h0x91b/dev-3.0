import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/** Background tool calls must not overwrite the parent conversation's approval wait. */
export async function handleClaudePreTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;
	try {
		const payload = JSON.parse(rawInput) as Record<string, unknown>;
		if (!payload || Array.isArray(payload)) return;
		if (payload.hook_event_name !== "PreToolUse") return;
		if (typeof payload.agent_id === "string" && payload.agent_id) return;
		const response = await sendRequest(socketPath, "task.move", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			newStatus: "in-progress",
			ifStatusNot: "review-by-ai",
			sourceTaskId: context.taskId,
		});
		if (!response.ok) process.stderr.write(`dev3 Claude tool hook: ${response.error || "status update failed"}\n`);
	} catch (error) {
		process.stderr.write(`dev3 Claude tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
