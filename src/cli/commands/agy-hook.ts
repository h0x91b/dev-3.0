import { AGY_HOOK_EVENTS, type AgyHookEvent } from "../../shared/agent-hooks";
import { skillBodyFor } from "../../shared/agent-skill-content";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { reportStatusHookEvent } from "./status-hook-request";

interface AgyHookPayload {
	event?: AgyHookEvent;
	conversationId?: string;
	/** `Stop` only: why the turn ended (`NO_TOOL_CALL` is a normal end, `ERROR` is not). */
	terminationReason?: string;
}

function isAgyEvent(value: unknown): value is AgyHookEvent {
	return AGY_HOOK_EVENTS.includes(value as AgyHookEvent);
}

function parsePayload(rawInput: string): AgyHookPayload {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		return {
			...(isAgyEvent(parsed.hookEventName) ? { event: parsed.hookEventName } : {}),
			...(typeof parsed.conversationId === "string" && parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
			...(typeof parsed.terminationReason === "string" ? { terminationReason: parsed.terminationReason } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * A turn that ended on an error leaves agy idle at its prompt with nothing to
 * show for it, so it is parked in front of the user like Claude's StopFailure.
 * Reuses that socket method: the board move and the attention badge are the same.
 */
async function reportStoppedOnError(socketPath: string, context: CliContext): Promise<void> {
	try {
		const response = await sendRequest(socketPath, "task.claudeStopFailure", {
			taskId: context.taskId,
			projectId: context.projectId,
			error: "unknown",
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) process.stderr.write(`dev3 agy hook: ${response.error || "status update failed"}\n`);
	} catch (error) {
		process.stderr.write(`dev3 agy hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/**
 * The protocol as a persistent system message. Hooks are only written into a
 * worktree dev3 owns, where a task always runs in the worktree protocol mode.
 */
function sessionStartOutput(): string {
	return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: skillBodyFor("agy", "worktree") } }] });
}

/**
 * Internal Antigravity CLI (`agy`) lifecycle adapter. `event` is the name the
 * hook command passes; the payload's own `hookEventName` backs it up.
 *
 * It must always print valid JSON and exit 0: agy parses stdout as JSON, and a
 * dev3 that is merely offline must never be able to block the agent.
 */
export async function handleAgyHook(
	eventArg: string,
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const payload = parsePayload(rawInput);
	const event = isAgyEvent(eventArg) ? eventArg : payload.event;
	let output = "{}";

	try {
		if (event === "SessionStart" && context?.taskId) output = sessionStartOutput();
		if (event && socketPath && context?.taskId) {
			if (event === "Stop" && payload.terminationReason === "ERROR") {
				await reportStoppedOnError(socketPath, context);
			} else {
				await reportStatusHookEvent({
					harness: "agy",
					event: event === "SessionStart" ? "SessionStart" : event === "Stop" ? "Stop" : "UserPromptSubmit",
					...(payload.conversationId ? { sessionId: payload.conversationId } : {}),
				}, socketPath, context);
			}
		}
	} catch (error) {
		process.stderr.write(`dev3 agy hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}

	process.stdout.write(output);
}
