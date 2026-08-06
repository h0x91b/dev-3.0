import { parseClaudeStopFailurePayload } from "../../shared/agent-stop-failure";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/**
 * Internal adapter for Claude Code's `StopFailure` hook. Claude ignores this
 * hook's exit code and output, and a board update must never look like a failure
 * to the agent either, so every path here ends quietly with exit 0.
 */
export async function handleClaudeStopFailure(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parseClaudeStopFailurePayload(rawInput);
	if (!payload || !socketPath || !context?.taskId) return;

	try {
		const response = await sendRequest(socketPath, "task.claudeStopFailure", {
			taskId: context.taskId,
			projectId: context.projectId,
			error: payload.error,
			...(payload.errorDetails ? { errorDetails: payload.errorDetails } : {}),
			...(payload.lastAssistantMessage ? { lastAssistantMessage: payload.lastAssistantMessage } : {}),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) {
			process.stderr.write(`dev3 Claude StopFailure hook: ${response.error || "status update failed"}\n`);
		}
	} catch (error) {
		process.stderr.write(
			`dev3 Claude StopFailure hook: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
