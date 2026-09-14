import {
	STATUS_HOOK_EVENTS,
	CODEX_STOP_HOOK_SUCCESS_JSON,
	type StatusHookEvent,
} from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { reportStatusHookEvent, type StatusHookReport } from "./status-hook-request";

function parsePayload(rawInput: string): StatusHookReport | null {
	try {
		const parsed = JSON.parse(rawInput) as {
			hook_event_name?: unknown;
			session_id?: unknown;
			prompt?: unknown;
			turn_id?: unknown;
		};
		if (typeof parsed.hook_event_name !== "string") return null;
		if (!STATUS_HOOK_EVENTS.includes(parsed.hook_event_name as StatusHookEvent)) {
			return null;
		}
		return {
			harness: "codex",
			event: parsed.hook_event_name as StatusHookEvent,
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			// Codex's own per-turn identity.
			...(typeof parsed.turn_id === "string" ? { submissionId: parsed.turn_id } : {}),
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
	if (payload) await reportStatusHookEvent(payload, socketPath, context);
	process.stdout.write(CODEX_STOP_HOOK_SUCCESS_JSON);
}
