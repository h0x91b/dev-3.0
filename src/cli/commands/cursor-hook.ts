import { cursorStatusEvent } from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { reportStatusHookEvent } from "./status-hook-request";

interface CursorHookPayload {
	/** Per submission, stable across a redelivery: names the prompt for the terminal-prompt log. */
	generationId?: string;
	prompt?: string;
	toolInput?: unknown;
	/** `stop` only: completed, aborted or error. */
	status?: string;
}

function parsePayload(rawInput: string): CursorHookPayload {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		return {
			...(typeof parsed.generation_id === "string" && parsed.generation_id ? { generationId: parsed.generation_id } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			...("tool_input" in parsed ? { toolInput: parsed.tool_input } : {}),
			...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
		};
	} catch {
		return {};
	}
}

/** A turn that ended on an error is parked in front of the user, like agy's and Claude's. */
async function reportStoppedOnError(socketPath: string, context: CliContext): Promise<void> {
	try {
		const response = await sendRequest(socketPath, "task.claudeStopFailure", {
			taskId: context.taskId,
			projectId: context.projectId,
			error: "unknown",
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) process.stderr.write(`dev3 cursor hook: ${response.error || "status update failed"}\n`);
	} catch (error) {
		process.stderr.write(`dev3 cursor hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/**
 * Internal Cursor Agent CLI lifecycle adapter (`dev3 hook cursor <event>`).
 *
 * No session id is sent: dev3 pre-assigns Cursor's chat id at launch, so there
 * is nothing to capture, and Cursor's `conversation_id` is not proven to be it.
 * It always prints `{}` and exits 0 — Cursor's "no opinion" — so a dev3 that is
 * offline or failing can never block a prompt or a tool.
 */
export async function handleCursorHook(
	eventArg: string,
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	const event = cursorStatusEvent(eventArg, { toolInput: payload.toolInput, stopStatus: payload.status });
	try {
		if (event && socketPath && context?.taskId) {
			if (event === "Stop" && payload.status === "error") {
				await reportStoppedOnError(socketPath, context);
			} else {
				await reportStatusHookEvent({
					harness: "cursor",
					event,
					...(event === "UserPromptSubmit" && payload.prompt ? { prompt: payload.prompt } : {}),
					...(event === "UserPromptSubmit" && payload.generationId ? { turnId: payload.generationId } : {}),
				}, socketPath, context);
			}
		}
	} catch (error) {
		process.stderr.write(`dev3 cursor hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	process.stdout.write("{}");
}
