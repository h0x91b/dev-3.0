import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeToolHookFields } from "./claude-tool-fields";

/**
 * Status observation and the prompt ledger (an AskUserQuestion opens a picker; any
 * later tool call means an earlier prompt is gone). Must never block a tool or grant
 * Claude permission to run it.
 */
export async function handleClaudePreTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	let cursor = false;
	try {
		const payload = JSON.parse(rawInput);
		cursor = typeof payload?.cursor_version === "string";
	} catch { /* An unreadable payload still gets a neutral Claude response. */ }

	try {
		if (socketPath && context?.taskId) {
			const move = {
				taskId: context.taskId,
				projectId: context.projectId,
				sourceTaskId: context.taskId,
				newStatus: "in-progress",
				ifStatusNot: "review-by-ai",
			};
			// Cursor imports these hooks but reports no prompts dev3 could track.
			const response = cursor
				? await sendRequest(socketPath, "task.move", move, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 })
				: await sendRequest(socketPath, "task.claudePreToolUse", { ...move, ...claudeToolHookFields(rawInput, env) }, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
			const moveError = (response.data as { moveError?: unknown } | undefined)?.moveError;
			if (!response.ok) process.stderr.write(`dev3 pre-tool hook: ${response.error || "status update failed"}\n`);
			else if (typeof moveError === "string") process.stderr.write(`dev3 pre-tool hook: ${moveError}\n`);
		}
	} catch (error) {
		process.stderr.write(`dev3 pre-tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	// Cursor imports Claude hooks but requires an explicit native permission response.
	// Claude gets no permission decision, so its normal approval checks still run.
	process.stdout.write(JSON.stringify(cursor ? { permission: "allow" } : {}));
}
