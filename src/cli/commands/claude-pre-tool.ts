import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { parseClaudeToolStatus } from "../../shared/claude-status-hook";
import { claudeToolHookFields } from "./claude-tool-fields";

const HOOK_REQUEST = { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 };

/**
 * Status observation with its owner (conversation and background agent) and the prompt
 * ledger (an AskUserQuestion opens a picker; any later tool call means an earlier prompt
 * is gone). Also reports Notification, SubagentStop and TeammateIdle. Must never block a
 * tool or grant Claude permission to run it.
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
			const task = { taskId: context.taskId, ...(context.projectId ? { projectId: context.projectId } : {}) };
			let response: Awaited<ReturnType<typeof sendRequest>> | null = null;
			if (cursor) {
				// Cursor imports these hooks but reports no prompts or owners dev3 could track.
				response = await sendRequest(socketPath, "task.move", {
					...task, sourceTaskId: context.taskId, newStatus: "in-progress", ifStatusNot: "review-by-ai",
				}, HOOK_REQUEST);
			} else {
				const status = parseClaudeToolStatus(rawInput);
				if (status?.event === "PreToolUse") {
					response = await sendRequest(socketPath, "task.claudePreToolUse", {
						...task, ...claudeToolHookFields(rawInput, env), ...status,
					}, HOOK_REQUEST);
				} else if (status && status.event !== "PostToolUse") {
					response = await sendRequest(socketPath, "task.claudeToolStatus", { ...task, ...status }, HOOK_REQUEST);
				}
			}
			const moveError = (response?.data as { moveError?: unknown } | undefined)?.moveError;
			if (response && !response.ok) process.stderr.write(`dev3 pre-tool hook: ${response.error || "status update failed"}\n`);
			else if (typeof moveError === "string") process.stderr.write(`dev3 pre-tool hook: ${moveError}\n`);
		}
	} catch (error) {
		process.stderr.write(`dev3 pre-tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	// Cursor imports Claude hooks but requires an explicit native permission response.
	// Claude gets no permission decision, so its normal approval checks still run.
	process.stdout.write(JSON.stringify(cursor ? { permission: "allow" } : {}));
}
