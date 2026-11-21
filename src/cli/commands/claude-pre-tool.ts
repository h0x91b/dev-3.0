import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/** Status observation must never block a tool or grant Claude permission to run it. */
export async function handleClaudePreTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	let cursor = false;
	try {
		const payload = JSON.parse(rawInput);
		cursor = typeof payload?.cursor_version === "string";
	} catch { /* An unreadable payload still gets a neutral Claude response. */ }

	try {
		if (socketPath && context?.taskId) {
			const response = await sendRequest(socketPath, "task.move", {
				taskId: context.taskId,
				projectId: context.projectId,
				sourceTaskId: context.taskId,
				newStatus: "in-progress",
				ifStatusNot: "review-by-ai",
			}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
			if (!response.ok) process.stderr.write(`dev3 pre-tool hook: ${response.error || "status update failed"}\n`);
		}
	} catch (error) {
		process.stderr.write(`dev3 pre-tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	// Cursor imports Claude hooks but requires an explicit native permission response.
	// Claude gets no permission decision, so its normal approval checks still run.
	process.stdout.write(JSON.stringify(cursor ? { permission: "allow" } : {}));
}
