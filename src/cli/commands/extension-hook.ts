import { AGENT_STATUS_HOOK_EVENTS, type AgentStatusHookEvent } from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { reportStatusHookEvent, type StatusHookReport } from "./status-hook-request";

/** The harnesses whose status arrives from a generated in-process extension. */
export type ExtensionHookHarness = "omp" | "pi";

/**
 * The payload a generated status extension writes to stdin
 * (`src/shared/status-extension-core.ts`): already in the status-hook
 * vocabulary, with the extension's own random `submissionId` on a human prompt.
 */
function parsePayload(harness: ExtensionHookHarness, rawInput: string): StatusHookReport | null {
	try {
		const parsed = JSON.parse(rawInput) as {
			event?: unknown;
			sessionId?: unknown;
			prompt?: unknown;
			submissionId?: unknown;
		};
		if (typeof parsed.event !== "string") return null;
		if (!AGENT_STATUS_HOOK_EVENTS.includes(parsed.event as AgentStatusHookEvent)) return null;
		return {
			harness,
			event: parsed.event as AgentStatusHookEvent,
			...(typeof parsed.sessionId === "string" && parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			...(typeof parsed.submissionId === "string" && parsed.submissionId
				? { turnId: parsed.submissionId }
				: {}),
		};
	} catch {
		return null;
	}
}

/**
 * Internal lifecycle adapter behind `dev3 hook omp` and `dev3 hook pi`. Prints
 * nothing — the extension reads no reply — and always exits successfully, so a
 * status-sync failure can never reach the agent.
 */
export async function handleExtensionHook(
	harness: ExtensionHookHarness,
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(harness, rawInput);
	if (payload) await reportStatusHookEvent(payload, socketPath, context);
}
