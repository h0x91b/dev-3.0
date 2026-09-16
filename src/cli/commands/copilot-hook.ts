import { copilotStatusEvent } from "../../shared/agent-hooks";
import { GENERIC_SKILL_BODY } from "../../shared/agent-skill-content";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

interface CopilotHookPayload {
	/** The submitted text, on `userPromptSubmitted` only. */
	prompt?: string;
	/** The tool about to run or just finished, on the two tool events. */
	toolName?: string;
	sessionId?: string;
	/** Copilot gives no per-submission id, so the event's own millisecond stamp
	 *  stands in: it is stable across a redelivery and differs per submission. */
	turnId?: string;
}

function parsePayload(rawInput: string): CopilotHookPayload {
	try {
		const parsed = JSON.parse(rawInput) as {
			sessionId?: unknown;
			prompt?: unknown;
			timestamp?: unknown;
			toolName?: unknown;
			tool_name?: unknown;
		};
		// Copilot emits camelCase to `settings.json` hooks; the snake_case twin is
		// read too so a payload from the documented alternate shape still routes.
		const tool = typeof parsed.toolName === "string" ? parsed.toolName : parsed.tool_name;
		return {
			...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			...(typeof parsed.timestamp === "number" ? { turnId: String(parsed.timestamp) } : {}),
			...(typeof tool === "string" ? { toolName: tool } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * Internal GitHub Copilot CLI lifecycle adapter.
 *
 * Two jobs on one event. Every event syncs the board; `sessionStart` ALSO
 * answers with the dev3 protocol as `additionalContext`, which is the only
 * channel Copilot has for out-of-band instructions — it reaches fresh, scratch
 * and resumed sessions alike, and never touches the user's repository files.
 *
 * It must always exit 0 with valid JSON on stdout: Copilot treats a non-zero
 * `preToolUse` hook as fail-closed and would block the tool call outright, so a
 * dev3 that is merely offline must never be able to wedge the agent.
 */
export async function handleCopilotHook(
	event: string,
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	const mapped = copilotStatusEvent(event, payload.toolName);

	if (mapped && socketPath && context?.taskId) {
		const paneId = typeof process.env.TMUX_PANE === "string" && process.env.TMUX_PANE
			? process.env.TMUX_PANE
			: undefined;
		try {
			const response = await sendRequest(socketPath, "task.agentHook", {
				taskId: context.taskId,
				projectId: context.projectId,
				event: mapped,
				harness: "copilot",
				...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
				...(paneId ? { paneId } : {}),
				...(event === "userPromptSubmitted" && payload.prompt ? { prompt: payload.prompt } : {}),
				...(payload.turnId ? { turnId: payload.turnId } : {}),
			}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
			if (!response.ok) {
				process.stderr.write(`dev3 Copilot hook: ${response.error || "status update failed"}\n`);
			}
		} catch (error) {
			process.stderr.write(
				`dev3 Copilot hook: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}

	process.stdout.write(
		event === "sessionStart"
			? JSON.stringify({ additionalContext: GENERIC_SKILL_BODY })
			: "{}",
	);
}
