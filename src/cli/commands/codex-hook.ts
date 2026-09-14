import { createHash } from "node:crypto";
import {
	AGENT_STATUS_HOOK_EVENTS,
	CODEX_STOP_HOOK_SUCCESS_JSON,
	type AgentStatusHookEvent,
} from "../../shared/agent-hooks";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

interface CodexHookPayload {
	event: AgentStatusHookEvent;
	toolName?: string;
	toolUseId?: string;
	questionIds?: string[];
	answeredQuestionId?: string;
	sessionId?: string;
	/** The submitted text, on `UserPromptSubmit` only. */
	prompt?: string;
	/** Codex's own per-turn identity — how a redelivered hook is recognised. */
	turnId?: string;
}

function questionFingerprint(title: string): string {
	return createHash("sha256").update(title).digest("hex");
}

function framedQuestionTitle(title: string): string {
	let prefix = "";
	for (const character of title) {
		if (Buffer.byteLength(prefix + character, "utf8") > 512) break;
		prefix += character;
	}
	return prefix.replace(/[\r\n]/g, " ");
}

function parsePayload(rawInput: string): CodexHookPayload | null {
	try {
		const parsed = JSON.parse(rawInput) as {
			hook_event_name?: unknown;
			tool_name?: unknown;
			tool_use_id?: unknown;
			tool_input?: { questions?: unknown };
			session_id?: unknown;
			prompt?: unknown;
			turn_id?: unknown;
		};
		if (typeof parsed.hook_event_name !== "string") return null;
		if (!AGENT_STATUS_HOOK_EVENTS.includes(parsed.hook_event_name as AgentStatusHookEvent)) {
			return null;
		}
		const questionIds = parsed.hook_event_name === "PostToolUse"
			&& /^(functions\.)?request_user_input_async$/.test(String(parsed.tool_name))
			&& Array.isArray(parsed.tool_input?.questions)
			? parsed.tool_input.questions.flatMap(question =>
				question && typeof question.title === "string" ? [questionFingerprint(framedQuestionTitle(question.title))] : [])
			: [];
		// Codex's AnsweredQuestion framing is a bounded blockquote, followed by
		// the answer. Match it to queued titles without retaining question text.
		const answeredTitle = parsed.hook_event_name === "UserPromptSubmit" && typeof parsed.prompt === "string"
			? /^> ([^\n]*)\n\n/.exec(parsed.prompt)?.[1] : undefined;
		return {
			event: parsed.hook_event_name as AgentStatusHookEvent,
			...(questionIds.length ? { questionIds } : {}),
			...(answeredTitle !== undefined ? { answeredQuestionId: questionFingerprint(answeredTitle) } : {}),
			...(typeof parsed.tool_name === "string" ? { toolName: parsed.tool_name } : {}),
			...(typeof parsed.tool_use_id === "string" ? { toolUseId: parsed.tool_use_id } : {}),
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
			...(typeof parsed.prompt === "string" && parsed.prompt.trim() ? { prompt: parsed.prompt } : {}),
			...(typeof parsed.turn_id === "string" ? { turnId: parsed.turn_id } : {}),
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
		// The hook runs inside the Codex pane, so $TMUX_PANE identifies which pane
		// this session belongs to. Combined with the payload's session_id (== the
		// resumable rollout id), it lets dev3 record each pane's Codex session for
		// targeted recovery — essential when several Codex sessions (e.g. multiple
		// bug hunters) share one worktree. Codex has no launch-time --session-id, so
		// this post-hoc capture is the only way to resume the exact session per pane.
		const paneId = typeof process.env.TMUX_PANE === "string" && process.env.TMUX_PANE
			? process.env.TMUX_PANE
			: undefined;
		try {
			const response = await sendRequest(socketPath, "task.agentHook", {
				taskId: context.taskId,
				projectId: context.projectId,
				event: payload.event,
				...(payload.questionIds ? { questionIds: payload.questionIds } : {}),
				...(payload.answeredQuestionId ? { answeredQuestionId: payload.answeredQuestionId } : {}),
				...(payload.toolName ? { toolName: payload.toolName } : {}),
				...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
				...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
				...(paneId ? { paneId } : {}),
				// Carried on the status hook so a submitted prompt costs the pane no
				// second dev3 process; what happens to it is decided app-side.
				...(payload.event === "UserPromptSubmit" && payload.prompt ? { prompt: payload.prompt } : {}),
				...(payload.turnId ? { turnId: payload.turnId } : {}),
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
