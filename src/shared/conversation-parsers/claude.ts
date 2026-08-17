/**
 * Claude Code transcript parser: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * One JSON record per line. Conversation records (`user`, `assistant`) carry an
 * Anthropic message whose content blocks hold text, thinking, tool_use and
 * tool_result; everything else on the line (`attachment`, `system`, `mode`,
 * `ai-title`, …) is session bookkeeping that we keep as lifecycle events rather
 * than throw away. Records are threaded by `parentUuid`, so a conversation is a
 * tree — we preserve the pointers and leave the flattening to the reader.
 */

import {
	CONVERSATION_PARSER_VERSION,
	CONVERSATION_SCHEMA_VERSION,
	emptyStats,
	numberAt,
	recordAt,
	scanJsonl,
	stringAt,
	routeEvents,
	summarizeEvents,
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

/** Non-message record types we map to lifecycle events instead of counting as unknown.
 *  `agent-setting` records the subagent type in use and shows up in subagent
 *  transcripts — it was found by the unknown-record counter, not by guessing. */
const LIFECYCLE_TYPES = new Set([
	"system",
	"mode",
	"permission-mode",
	"last-prompt",
	"summary",
	"ai-title",
	"agent-setting",
]);

function usageFrom(message: Record<string, unknown> | undefined): ConversationUsage | undefined {
	const usage = recordAt(message, "usage");
	if (!usage) return undefined;
	return {
		input: numberAt(usage, "input_tokens"),
		output: numberAt(usage, "output_tokens"),
		cacheRead: numberAt(usage, "cache_read_input_tokens"),
		cacheWrite: numberAt(usage, "cache_creation_input_tokens"),
	};
}

function roleOf(record: Record<string, unknown>, message: Record<string, unknown> | undefined): ConversationRole {
	const role = stringAt(message, "role");
	if (role === "user" || role === "assistant" || role === "system") return role;
	return record.type === "assistant" ? "assistant" : "user";
}

/** Split one `user`/`assistant` record into its per-block events. */
function eventsFromMessage(
	record: Record<string, unknown>,
	seq: number,
	includeRaw: boolean,
): ConversationEvent[] {
	const message = recordAt(record, "message");
	const uuid = stringAt(record, "uuid") ?? String(seq);
	const base = {
		seq,
		parentId: stringAt(record, "parentUuid"),
		timestamp: stringAt(record, "timestamp"),
		role: roleOf(record, message),
		sidechain: record.isSidechain === true ? true : undefined,
		...(includeRaw ? { raw: record } : {}),
	};

	const content = message?.content;
	const events: ConversationEvent[] = [];

	// A bare string body has no blocks to walk.
	if (typeof content === "string") {
		if (content.trim()) events.push({ ...base, id: uuid, kind: "message", text: content });
		attachUsage(events, base, uuid, record, message);
		return events;
	}

	const blocks = Array.isArray(content) ? content : [];
	let part = 0;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		const type = typeof b.type === "string" ? b.type : "text";
		// Several events can come off one record, so ids get a block suffix.
		const id = blocks.length > 1 ? `${uuid}#${part++}` : uuid;

		if (type === "thinking") {
			// The body lives in `thinking`, not `text`, and arrives empty when the
			// block is signature-only (redacted). The block still proves reasoning
			// happened, so it becomes an event either way.
			const text = typeof b.thinking === "string" ? b.thinking : "";
			events.push({
				...base,
				id,
				kind: "thinking",
				text: text || undefined,
				meta: text ? undefined : { redacted: true },
			});
			continue;
		}

		if (type === "text") {
			const text = typeof b.text === "string" ? b.text : "";
			if (!text.trim()) continue;
			events.push({ ...base, id, kind: "message", text });
			continue;
		}

		if (type === "tool_use") {
			const name = stringAt(b, "name") ?? undefined;
			events.push({
				...base,
				id,
				kind: "tool-call",
				tool: {
					callId: stringAt(b, "id") ?? undefined,
					name,
					input: b.input,
					canonical: normalizeToolCall("claude", name, b.input),
				},
			});
			continue;
		}

		if (type === "tool_result") {
			events.push({
				...base,
				id,
				kind: "tool-result",
				role: "tool",
				tool: {
					callId: stringAt(b, "tool_use_id") ?? undefined,
					// `toolUseResult` on the record is the structured form of the same
					// result; the block's own content is the model-visible rendering.
					output: toolOutputText(b.content ?? record.toolUseResult),
					isError: b.is_error === true ? true : undefined,
				},
			});
			continue;
		}

		// Unknown block type (e.g. an image): keep it as an attachment so the
		// event count still matches the transcript.
		events.push({ ...base, id, kind: "attachment", meta: { blockType: type } });
	}

	attachUsage(events, base, uuid, record, message);
	return events;
}

/**
 * Token usage is billed per *record*, not per block — streaming splits one
 * assistant turn into thinking-only, tool_use-only and text-only records, each
 * with its own `usage`. Attaching it to whichever event came first keeps the sum
 * equal to the file's, and a record whose blocks produced nothing still keeps its
 * cost as a lifecycle event.
 */
function attachUsage(
	events: ConversationEvent[],
	base: Omit<ConversationEvent, "id" | "kind">,
	uuid: string,
	record: Record<string, unknown>,
	message: Record<string, unknown> | undefined,
): void {
	const usage = usageFrom(message);
	if (!usage) return;
	if (events.length > 0) events[0].usage = usage;
	else events.push({ ...base, id: uuid, kind: "lifecycle", meta: { recordType: String(record.type) }, usage });
}

export function parseClaudeTranscript(
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
	let gitBranch: string | null = null;
	let model: string | null = null;
	let title: string | null = null;

	scan.records.forEach((record, seq) => {
		sessionId ??= stringAt(record, "sessionId") ?? stringAt(record, "session_id");
		cwd ??= stringAt(record, "cwd");
		gitBranch ??= stringAt(record, "gitBranch");
		const type = typeof record.type === "string" ? record.type : "";

		if (type === "user" || type === "assistant") {
			model ??= stringAt(recordAt(record, "message"), "model");
			// A record can yield an attachment or a usage-only marker, which belong
			// to the session layer even though the record was a message.
			routeEvents(eventsFromMessage(record, seq, includeRaw), events, sessionEvents);
			return;
		}

		if (type === "attachment") {
			const attachment = recordAt(record, "attachment");
			sessionEvents.push({
				id: stringAt(record, "uuid") ?? String(seq),
				seq,
				parentId: stringAt(record, "parentUuid"),
				timestamp: stringAt(record, "timestamp"),
				kind: "attachment",
				meta: { attachmentType: stringAt(attachment, "type") ?? "unknown" },
				...(includeRaw ? { raw: record } : {}),
			});
			return;
		}

		if (LIFECYCLE_TYPES.has(type)) {
			title ??= stringAt(record, "aiTitle");
			sessionEvents.push({
				id: stringAt(record, "uuid") ?? String(seq),
				seq,
				parentId: stringAt(record, "parentUuid"),
				timestamp: stringAt(record, "timestamp"),
				kind: "lifecycle",
				meta: { recordType: type, ...(stringAt(record, "subtype") ? { subtype: stringAt(record, "subtype") } : {}) },
				...(includeRaw ? { raw: record } : {}),
			});
			return;
		}

		stats.unknownRecords++;
		sessionEvents.push({
			id: stringAt(record, "uuid") ?? String(seq),
			seq,
			timestamp: stringAt(record, "timestamp"),
			kind: "lifecycle",
			meta: { recordType: type || "(missing)", unknown: true },
			...(includeRaw ? { raw: record } : {}),
		});
	});

	summarizeEvents(events, sessionEvents, stats);
	const turns = assembleTurns(events);
	stats.turns = turns.length;
	const span = timeSpanOf([...events, ...sessionEvents].sort((a, b) => a.seq - b.seq));

	if (scan.truncatedTail) warnings.push("Last line was truncated — the session is probably still being written.");
	if (stats.malformedLines > 0) warnings.push(`${stats.malformedLines} line(s) were not valid JSON.`);
	if (stats.unknownRecords > 0) warnings.push(`${stats.unknownRecords} record(s) had a type this parser does not map.`);

	return {
		schemaVersion: CONVERSATION_SCHEMA_VERSION,
		parserVersion: CONVERSATION_PARSER_VERSION,
		source: "claude",
		sessionId,
		sourcePath,
		cwd,
		gitBranch,
		model,
		title,
		startedAt: span.startedAt,
		endedAt: span.endedAt,
		turns,
		sessionEvents,
		stats,
		fidelity: { level: warnings.length === 0 ? "full" : "partial", warnings },
	};
}
