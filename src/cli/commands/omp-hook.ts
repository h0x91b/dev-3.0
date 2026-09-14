import { STATUS_HOOK_EVENTS, type StatusHookEvent } from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { reportStatusHookEvent, type StatusHookReport } from "./status-hook-request";

/**
 * The payload the generated omp status extension writes to stdin
 * (`src/shared/omp-status-extension.ts`): already in the status-hook
 * vocabulary, with the extension's own random `submissionId` on a human prompt.
 */
function parsePayload(rawInput: string): StatusHookReport | null {
	try {
		const parsed = JSON.parse(rawInput) as {
			event?: unknown;
			sessionId?: unknown;
			prompt?: unknown;
			submissionId?: unknown;
		};
		if (typeof parsed.event !== "string") return null;
		if (!STATUS_HOOK_EVENTS.includes(parsed.event as StatusHookEvent)) return null;
		return {
			harness: "omp",
			event: parsed.event as StatusHookEvent,
			...(typeof parsed.sessionId === "string" && parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			...(typeof parsed.submissionId === "string" && parsed.submissionId
				? { submissionId: parsed.submissionId }
				: {}),
		};
	} catch {
		return null;
	}
}

/**
 * Internal omp lifecycle adapter. Prints nothing — omp reads no reply — and
 * always exits successfully, so a status-sync failure can never reach the agent.
 */
export async function handleOmpHook(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	if (payload) await reportStatusHookEvent(payload, socketPath, context);
}
