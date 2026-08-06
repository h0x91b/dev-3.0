/**
 * Claude Code's `StopFailure` hook — the turn ended on an API error.
 *
 * It fires INSTEAD of `Stop`, so without handling it a task whose turn died on a
 * usage limit (or an auth/billing failure) keeps sitting in "Agent is Working"
 * forever: the agent is idle at its prompt and nothing on the board says so.
 * dev3 turns every such event into a Has Questions move plus an attention badge.
 */

/** The `error` values Claude Code can put in a StopFailure payload. */
export const CLAUDE_STOP_FAILURE_ERRORS = [
	"rate_limit",
	"authentication_failed",
	"billing_error",
	"invalid_request",
	"server_error",
	"max_output_tokens",
	"unknown",
] as const;

export type ClaudeStopFailureError = typeof CLAUDE_STOP_FAILURE_ERRORS[number];

export interface ClaudeStopFailurePayload {
	error: ClaudeStopFailureError;
	errorDetails?: string;
	lastAssistantMessage?: string;
}

/** Longest reason we put on a badge — it has to stay readable on a task card. */
export const STOP_FAILURE_REASON_MAX_LEN = 120;

const REASON_BY_ERROR: Record<ClaudeStopFailureError, string> = {
	rate_limit: "Usage limit reached — the agent stopped mid-task",
	authentication_failed: "The agent must sign in again",
	billing_error: "Billing blocked the request",
	invalid_request: "The API rejected the request",
	server_error: "The API is failing — the turn was dropped",
	max_output_tokens: "The reply hit the output cap",
	unknown: "The turn ended on an API error",
};

/**
 * Claude's own limit sentences, e.g. "You've hit your session limit · resets
 * 3:40pm (Asia/Jerusalem)". They carry the reset time, which no payload field
 * does, so they beat any wording of ours — but only when the last message really
 * is one of them and not an ordinary reply.
 */
const LIMIT_SENTENCE_PREFIXES = [
	"You've hit your",
	"You've used",
	"You're out of",
	"You're close to",
	"You're now using extra usage",
];

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

function truncate(text: string): string {
	if (text.length <= STOP_FAILURE_REASON_MAX_LEN) return text;
	return `${text.slice(0, STOP_FAILURE_REASON_MAX_LEN - 1).trimEnd()}…`;
}

/**
 * One short line for the attention badge and the notification body. Prefers
 * Claude's own limit sentence (it names the reset time) over our generic text.
 */
export function describeClaudeStopFailure(payload: ClaudeStopFailurePayload): string {
	const line = firstLine(payload.lastAssistantMessage ?? "");
	if (line && LIMIT_SENTENCE_PREFIXES.some((prefix) => line.startsWith(prefix))) {
		return truncate(line);
	}
	return truncate(REASON_BY_ERROR[payload.error] ?? REASON_BY_ERROR.unknown);
}

function asError(value: unknown): ClaudeStopFailureError {
	return CLAUDE_STOP_FAILURE_ERRORS.includes(value as ClaudeStopFailureError)
		? value as ClaudeStopFailureError
		: "unknown";
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Parse the hook's stdin JSON. Returns null only when this is not a StopFailure
 * event at all; an unrecognized `error` degrades to "unknown" so a newly added
 * Claude error value still parks the task instead of being dropped.
 *
 * Accepts the field pair from the shipped schema (`error` / `error_details`) and
 * the one the docs print (`stop_reason` / `error_message`) — they disagree, and
 * guessing wrong would silently swallow every event.
 */
export function parseClaudeStopFailurePayload(rawInput: string): ClaudeStopFailurePayload | null {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		if (parsed.hook_event_name !== "StopFailure") return null;
		const errorDetails = asText(parsed.error_details ?? parsed.error_message);
		const lastAssistantMessage = asText(parsed.last_assistant_message);
		return {
			error: asError(parsed.error ?? parsed.stop_reason),
			...(errorDetails ? { errorDetails } : {}),
			...(lastAssistantMessage ? { lastAssistantMessage } : {}),
		};
	} catch {
		return null;
	}
}
