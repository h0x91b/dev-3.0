import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { parseClaudeToolStatus } from "../../shared/claude-status-hook";

/** Report activity and permission waits with their conversation and background owner. */
export async function handleClaudePreTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;
	const status = parseClaudeToolStatus(rawInput);
	if (!status || status.event === "PostToolUse") return;
	try {
		const response = await sendRequest(socketPath, "task.claudeToolStatus", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			...status,
		});
		if (!response.ok) process.stderr.write(`dev3 Claude tool hook: ${response.error || "status update failed"}\n`);
	} catch (error) {
		process.stderr.write(`dev3 Claude tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
