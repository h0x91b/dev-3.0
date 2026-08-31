/**
 * Codex CLI rollout parser: `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`.
 *
 * Every line is `{timestamp, type, payload}`. Two streams share the file:
 * `response_item` is the model-facing history (messages, reasoning, tool calls
 * and their outputs) and `event_msg` is the UI event stream. They overlap —
 * `user_message`, `agent_message` and `agent_reasoning` restate content that
 * already exists as a `response_item`. We treat `response_item` as canonical and
 * count those three as duplicates, so no text lands in the output twice.
 *
 * Unlike Claude, the session id is not the filename: it lives in the
 * `session_meta` header line, together with the cwd.
 */

import {
	COMPACTION_RECORD_TYPE,
	CONVERSATION_PARSER_VERSION,
	CONVERSATION_SCHEMA_VERSION,
	emptyStats,
	numberAt,
	recordAt,
	routeEvents,
	scanJsonl,
	stringAt,
	summarizeEvents,
	textFromBlocks,
	timeSpanOf,
	toolOutputText,
	type ConversationEvent,
	type ConversationRole,
	type ConversationUsage,
	type ParsedConversation,
	assembleTurns,
} from "../conversation-model";
import { normalizeToolCall } from "../conversation-tools";
import type { ParseConversationOptions } from "./types";

/** UI events whose content is already covered by a `response_item`. */
const DUPLICATE_EVENTS = new Set(["user_message", "agent_message", "agent_reasoning"]);

/**
 * Blocks Codex writes into the `user` role itself: environment, skills, images,
 * an aborted turn, the AGENTS.md preamble. They are part of the model-facing
 * history and are kept, but they are not somebody speaking, so anything counting
 * or quoting the human's own requests must skip them.
 *
 * The list is explicit rather than "any leading tag" on purpose. `<dev3-ai-message>`
 * is agent-to-agent traffic that a person's board really did send, and a blanket
 * tag rule misclassified 686 of those across this machine's 826 rollouts.
 * Measured against Codex's own `event_msg`/`user_message` stream — which is
 * exactly what the UI showed as user input — the list below agrees on 99.8% of
 * 6 159 messages.
 */
const INJECTED_USER_TAGS = new Set([
	"app-context",
	"environment_context",
	"image",
	"in-app-browser-context",
	"multi_agent_mode",
	"permissions instructions",
	"recommended_plugins",
	"skill",
	"subagent_notification",
	"turn_aborted",
	"user_action",
	"user_instructions",
	"user_shell_command",
]);

const INJECTED_USER_HEADINGS = [
	"# AGENTS.md instructions",
	"# Files mentioned by the user:",
	"## Referenced ChatGPT conversation:",
	"Warning: apply_patch was requested via ",
];

const LEADING_TAG = /^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>/;

/** Is this `user` text Codex's own injected context rather than the human's words? */
export function isCodexInjectedUserText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	const tag = LEADING_TAG.exec(trimmed);
	// Both the name and the whole tag body: `<permissions instructions>` is only
	// ever the body, and `<image src=…>` is only ever the name.
	if (tag && (INJECTED_USER_TAGS.has(tag[1]) || INJECTED_USER_TAGS.has(tag[0].slice(1, -1).trim()))) return true;
	return INJECTED_USER_HEADINGS.some((heading) => trimmed.startsWith(heading));
}

function roleOf(payload: Record<string, unknown>): ConversationRole {
	const role = stringAt(payload, "role");
	if (role === "user" || role === "assistant" || role === "system" || role === "developer") return role;
	return "assistant";
}

/** Codex reports cumulative and per-turn usage; only the per-turn slice may be summed. */
function usageFromTokenCount(payload: Record<string, unknown>): ConversationUsage | undefined {
	const last = recordAt(recordAt(payload, "info"), "last_token_usage");
	if (!last) return undefined;
	return {
		input: numberAt(last, "input_tokens"),
		output: numberAt(last, "output_tokens"),
		cacheRead: numberAt(last, "cached_input_tokens"),
		cacheWrite: numberAt(last, "cache_write_input_tokens"),
	};
}

/** Reasoning summaries are `[{type:"summary_text", text}]`; the real chain is encrypted. */
function reasoningText(payload: Record<string, unknown>): string {
	return textFromBlocks(payload.summary, () => true);
}

function eventsFromResponseItem(
	payload: Record<string, unknown>,
	record: Record<string, unknown>,
	seq: number,
	includeRaw: boolean,
): ConversationEvent[] {
	const id = stringAt(payload, "id") ?? String(seq);
	const base = {
		seq,
		timestamp: stringAt(record, "timestamp"),
		...(includeRaw ? { raw: record } : {}),
	};
	const type = stringAt(payload, "type") ?? "";

	if (type === "message" || type === "agent_message") {
		const text = textFromBlocks(payload.content, (t) => t === "input_text" || t === "output_text" || t === "text");
		if (!text.trim()) return [];
		const role = roleOf(payload);
		const injected = role === "user" && isCodexInjectedUserText(text);
		return [{ ...base, id, kind: "message", role, text, ...(injected ? { meta: { injected: true } } : {}) }];
	}

	if (type === "reasoning") {
		const text = reasoningText(payload);
		if (!text.trim()) return [];
		return [{ ...base, id, kind: "thinking", role: "assistant", text }];
	}

	// `function_call` carries JSON-string arguments; `custom_tool_call` carries a
	// free-form `input` string. Both pair with their output via `call_id`.
	if (type === "function_call" || type === "custom_tool_call") {
		const name = stringAt(payload, "name") ?? undefined;
		const input = type === "function_call" ? payload.arguments : payload.input;
		return [
			{
				...base,
				id,
				kind: "tool-call",
				role: "assistant",
				tool: {
					callId: stringAt(payload, "call_id") ?? undefined,
					name,
					input,
					canonical: normalizeToolCall("codex", name, input),
				},
			},
		];
	}

	if (type === "function_call_output" || type === "custom_tool_call_output") {
		return [
			{
				...base,
				id,
				kind: "tool-result",
				role: "tool",
				tool: { callId: stringAt(payload, "call_id") ?? undefined, output: toolOutputText(payload.output) },
			},
		];
	}

	return [{ ...base, id, kind: "lifecycle", meta: { itemType: type || "(missing)", unknown: true } }];
}

export function parseCodexTranscript(
	body: string,
	sourcePath: string,
	options: ParseConversationOptions = {},
): ParsedConversation {
	const includeRaw = options.includeRaw === true;
	const scan = scanJsonl(body);
	const stats = emptyStats();
	stats.malformedLines = scan.malformedLines;

	const events: ConversationEvent[] = [];
	const sessionEvents: ConversationEvent[] = [];
	const warnings: string[] = [];
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let model: string | null = null;

	scan.records.forEach((record, seq) => {
		const payload = recordAt(record, "payload");
		const outer = stringAt(record, "type") ?? "";

		if (outer === "session_meta") {
			sessionId ??= stringAt(payload, "id") ?? stringAt(payload, "session_id");
			cwd ??= stringAt(payload, "cwd");
			sessionEvents.push({
				id: sessionId ?? String(seq),
				seq,
				timestamp: stringAt(record, "timestamp"),
				kind: "lifecycle",
				meta: { recordType: outer },
				...(includeRaw ? { raw: record } : {}),
			});
			return;
		}

		if (outer === "turn_context") {
			// The model can change mid-session; the first one wins as the label.
			model ??= stringAt(payload, "model");
			cwd ??= stringAt(payload, "cwd");
		}

		if (outer === "response_item" && payload) {
			const produced = eventsFromResponseItem(payload, record, seq, includeRaw);
			if (produced.some((e) => e.meta?.unknown === true)) stats.unknownRecords++;
			routeEvents(produced, events, sessionEvents);
			return;
		}

		if (outer === "event_msg" && payload) {
			const eventType = stringAt(payload, "type") ?? "";
			if (DUPLICATE_EVENTS.has(eventType)) {
				stats.duplicateRecords++;
				return;
			}
			sessionEvents.push({
				id: String(seq),
				seq,
				timestamp: stringAt(record, "timestamp"),
				kind: "lifecycle",
				// Codex reports the compaction as a plain UI event with no metrics; it
				// still gets the shared marker so a reader sees the boundary.
				meta:
					eventType === "compacted"
						? { recordType: COMPACTION_RECORD_TYPE, eventType }
						: { eventType: eventType || "(missing)" },
				usage: eventType === "token_count" ? usageFromTokenCount(payload) : undefined,
				...(includeRaw ? { raw: record } : {}),
			});
			return;
		}

		// turn_context / world_state / compacted / anything new: keep the marker.
		sessionEvents.push({
			id: String(seq),
			seq,
			timestamp: stringAt(record, "timestamp"),
			kind: "lifecycle",
			meta: { recordType: outer || "(missing)" },
			...(includeRaw ? { raw: record } : {}),
		});
	});

	summarizeEvents(events, sessionEvents, stats);
	const turns = assembleTurns(events);
	stats.turns = turns.length;
	const span = timeSpanOf([...events, ...sessionEvents].sort((a, b) => a.seq - b.seq));

	if (scan.truncatedTail) warnings.push("Last line was truncated — the session is probably still being written.");
	if (stats.malformedLines > 0) warnings.push(`${stats.malformedLines} line(s) were not valid JSON.`);
	if (stats.unknownRecords > 0) warnings.push(`${stats.unknownRecords} response item(s) had a type this parser does not map.`);
	// Codex encrypts the real reasoning chain and only ships a short summary.
	if (stats.thinkingBlocks > 0) warnings.push("Reasoning is a summary only — Codex stores the full chain encrypted.");

	return {
		schemaVersion: CONVERSATION_SCHEMA_VERSION,
		parserVersion: CONVERSATION_PARSER_VERSION,
		source: "codex",
		sessionId,
		sourcePath,
		cwd,
		gitBranch: null,
		model,
		title: null,
		startedAt: span.startedAt,
		endedAt: span.endedAt,
		turns,
		sessionEvents,
		stats,
		fidelity: { level: warnings.length === 0 ? "full" : "partial", warnings },
	};
}
