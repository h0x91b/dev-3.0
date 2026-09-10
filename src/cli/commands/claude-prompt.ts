import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/**
 * What Claude Code hands a `UserPromptSubmit` hook on stdin. Verified against
 * claude 2.1.267: `prompt_id` is a stable per-submission id, which is what lets
 * dev3 record a submission exactly once instead of matching on text and timing.
 */
interface ClaudePromptPayload {
	prompt: string;
	sessionId?: string;
	promptId?: string;
}

function parsePayload(rawInput: string): ClaudePromptPayload | null {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		if (parsed.hook_event_name !== "UserPromptSubmit") return null;
		if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
		return {
			prompt: parsed.prompt,
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
			...(typeof parsed.prompt_id === "string" ? { promptId: parsed.prompt_id } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Internal adapter for Claude Code's `UserPromptSubmit` hook: report the
 * submission so agent traffic can show a human message, and nothing else.
 *
 * The task's status is moved by the OTHER entry on the same event, which is
 * untouched. This one is pure recording, so every path here is quiet and
 * successful — a hook that exited non-zero would erase the user's prompt, and a
 * traffic row is never worth that.
 */
export async function handleClaudePrompt(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	if (!payload || !socketPath || !context?.taskId) return;

	try {
		const response = await sendRequest(socketPath, "task.promptSubmitted", {
			taskId: context.taskId,
			projectId: context.projectId,
			harness: "claude",
			prompt: payload.prompt,
			...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
			...(payload.promptId ? { submissionId: payload.promptId } : {}),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) {
			process.stderr.write(`dev3 Claude prompt hook: ${response.error || "recording failed"}\n`);
		}
	} catch (error) {
		process.stderr.write(
			`dev3 Claude prompt hook: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
