import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { hookIdentity } from "../hook-identity";

/**
 * What Claude Code hands a `SessionStart` / `SessionEnd` hook on stdin. Verified
 * against claude 2.1.273: both carry the same `session_id`, which is what lets
 * dev3 pair a start with its end and keep a multi-pane task honest.
 */
interface ClaudeSessionPayload {
	event: "SessionStart" | "SessionEnd";
	sessionId?: string;
}

function parsePayload(rawInput: string): ClaudeSessionPayload | null {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		const event = parsed.hook_event_name;
		if (event !== "SessionStart" && event !== "SessionEnd") return null;
		return {
			event,
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Internal adapter for Claude Code's session lifecycle: tell dev3 that an agent
 * session opened or closed, and nothing else.
 *
 * It moves no status and blocks nothing. Every path is quiet and exits 0 — a
 * non-zero SessionStart hook is a startup error in the user's face, and knowing
 * when the input box appeared is never worth that.
 */
export async function handleClaudeSession(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	if (!payload || !socketPath || !context?.taskId) return;

	try {
		const response = await sendRequest(socketPath, "task.agentSession", {
			taskId: context.taskId,
			projectId: context.projectId,
			harness: "claude",
			event: payload.event,
			...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
			// Where this receipt applies, and which launch it belongs to.
			...hookIdentity(),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) {
			process.stderr.write(`dev3 Claude session hook: ${response.error || "report failed"}\n`);
		}
	} catch (error) {
		process.stderr.write(
			`dev3 Claude session hook: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
