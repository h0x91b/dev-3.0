import {
	CODEX_STATUS_HOOK_EVENTS,
	CODEX_STOP_HOOK_SUCCESS_JSON,
	type CodexStatusHookEvent,
} from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

interface CodexHookPayload {
	event: CodexStatusHookEvent;
	sessionId?: string;
}

function parsePayload(rawInput: string): CodexHookPayload | null {
	try {
		const parsed = JSON.parse(rawInput) as {
			hook_event_name?: unknown;
			session_id?: unknown;
		};
		if (typeof parsed.hook_event_name !== "string") return null;
		if (!CODEX_STATUS_HOOK_EVENTS.includes(parsed.hook_event_name as CodexStatusHookEvent)) {
			return null;
		}
		return {
			event: parsed.hook_event_name as CodexStatusHookEvent,
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Internal Codex lifecycle adapter. It must always return valid Stop-hook JSON
 * and exit successfully: board synchronization must never block the agent when
 * dev3 is offline or a status update fails.
 */
export async function handleCodexHook(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);

	if (payload && socketPath && context?.taskId) {
		try {
			const response = await sendRequest(socketPath, "task.agentHook", {
				taskId: context.taskId,
				projectId: context.projectId,
				event: payload.event,
				...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
			}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
			if (!response.ok) {
				process.stderr.write(`dev3 Codex hook: ${response.error || "status update failed"}\n`);
			}
		} catch (error) {
			process.stderr.write(
				`dev3 Codex hook: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
}
