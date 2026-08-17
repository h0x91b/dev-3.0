/**
 * The canonical shape dev3 stores an agent conversation in, plus the pure
 * helpers every parser shares.
 *
 * Design constraints that shaped this (see the decision record):
 * - The native transcript stays the source of truth; a parsed conversation is a
 *   cache stamped with `parserVersion`, re-derivable at any time.
 * - Event log, not a message list: coding agents emit tool calls, tool results,
 *   reasoning and lifecycle records that a `{role, content}` array cannot hold.
 * - **Two layers.** `turns` is the conversation; `sessionEvents` is the agent's
 *   own bookkeeping (hook results, mode switches, injected boilerplate). Mixing
 *   them buries the conversation under its own plumbing — in a real session the
 *   plumbing is two thirds of the records.
 * - **Turns, not a flat stream.** A renderer targeting another client needs
 *   "what the user asked → what the agent did → what it answered" as a unit.
 * - Tool calls carry a canonical operation (see conversation-tools.ts), so the
 *   parsed form no longer speaks the source agent's dialect.
 * - Unknown record types are counted, never dropped silently — these formats are
 *   private and mutate between releases.
 */

import type { CanonicalToolCall } from "./conversation-tools";

/** Transcript formats dev3 can parse. One per native on-disk layout. */
export type ConversationSource = "claude" | "codex";

/** Bump when the emitted JSON's shape changes in a way readers must notice. */
export const CONVERSATION_SCHEMA_VERSION = 2;

/** Bump on any parser behavior change, so stale dumps can be re-derived. */
export const CONVERSATION_PARSER_VERSION = "2";

export type ConversationEventKind =
	| "message"
	| "thinking"
	| "tool-call"
	| "tool-result"
	| "attachment"
	| "lifecycle";

export type ConversationRole = "user" | "assistant" | "system" | "developer" | "tool";

/** Token accounting, when the transcript records it. */
export interface ConversationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ConversationToolInfo {
	/** Id linking a call to its result. The only reliable pairing key — results
	 *  do not always follow their call. */
	callId?: string;
	name?: string;
	input?: unknown;
	output?: string;
	isError?: boolean;
	/** What the call did, agent-independent. Present on `tool-call` events. */
	canonical?: CanonicalToolCall;
}

export interface ConversationEvent {
	/** Native record id when the format has one, else `seq` as a string. */
	id: string;
	/** Position in the file, 0-based. Stable ordering key. */
	seq: number;
	/** Native parent pointer, when the format threads records (Claude). */
	parentId?: string | null;
	timestamp?: string | null;
	kind: ConversationEventKind;
	role?: ConversationRole;
	text?: string;
	tool?: ConversationToolInfo;
	usage?: ConversationUsage;
	/** Claude sidechain (subagent) record — a branch, not the main thread. */
	sidechain?: boolean;
	/** Format-specific extras worth keeping but not worth a first-class field. */
	meta?: Record<string, unknown>;
	/** The untouched native record. Only populated when asked for. */
	raw?: unknown;
}

/**
 * One exchange: the user's prompt, everything the agent did in response, and the
 * reply it ended on. The unit a renderer re-tells to another client.
 */
export interface ConversationTurn {
	index: number;
	/** `preamble` covers whatever preceded the first user prompt. */
	trigger: "user" | "preamble";
	startedAt: string | null;
	endedAt: string | null;
	/** The prompt that opened this turn. Absent on the preamble. */
	userText?: string;
	/** The agent's last prose reply inside this turn, when it produced one. */
	assistantText?: string;
	events: ConversationEvent[];
	usage: ConversationUsage;
}

export interface ConversationStats {
	turns: number;
	events: number;
	/** Agent bookkeeping records, kept out of the conversation layer. */
	sessionEvents: number;
	messages: number;
	toolCalls: number;
	thinkingBlocks: number;
	/** Records the parser recognized as records but had no mapping for. */
	unknownRecords: number;
	/** Records deliberately skipped because another record already carries the
	 *  same content (Codex emits its UI event stream alongside the model history). */
	duplicateRecords: number;
	/** Lines that were not valid JSON (excluding a truncated trailing line). */
	malformedLines: number;
	usage: ConversationUsage;
}

/** How much of the original survived the parse. */
export interface ConversationFidelity {
	/** `full` — every record mapped; `partial` — something was skipped or lossy. */
	level: "full" | "partial";
	warnings: string[];
}

export interface ParsedConversation {
	schemaVersion: number;
	parserVersion: string;
	source: ConversationSource;
	/** The agent's own session id (what `--resume` takes). */
	sessionId: string | null;
	/** Absolute path of the native transcript this came from. */
	sourcePath: string;
	cwd: string | null;
	gitBranch: string | null;
	model: string | null;
	/** Agent-generated title, when the format records one. */
	title: string | null;
	startedAt: string | null;
	endedAt: string | null;
	/** The conversation itself, grouped into exchanges. */
	turns: ConversationTurn[];
	/** The agent's own bookkeeping, kept aside so it cannot bury the conversation. */
	sessionEvents: ConversationEvent[];
	stats: ConversationStats;
	fidelity: ConversationFidelity;
}

/** Every conversation event in file order, flattened back out of the turns. */
export function conversationEvents(parsed: ParsedConversation): ConversationEvent[] {
	return parsed.turns.flatMap((turn) => turn.events);
}

/** Every canonical tool call the conversation made, in order. */
export function toolCallsOf(parsed: ParsedConversation): CanonicalToolCall[] {
	const calls: CanonicalToolCall[] = [];
	for (const event of conversationEvents(parsed)) {
		if (event.kind === "tool-call" && event.tool?.canonical) calls.push(event.tool.canonical);
	}
	return calls;
}

export function emptyUsage(): ConversationUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(into: ConversationUsage, add: ConversationUsage): void {
	into.input += add.input;
	into.output += add.output;
	into.cacheRead += add.cacheRead;
	into.cacheWrite += add.cacheWrite;
}

/** Read a number off an unknown record, defaulting to 0. */
export function numberAt(obj: Record<string, unknown> | undefined, key: string): number {
	const value = obj?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function stringAt(obj: Record<string, unknown> | undefined, key: string): string | null {
	const value = obj?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function recordAt(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	const value = obj?.[key];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Join the `text` of every content block whose type the caller wants. Handles
 * the bare-string form both formats also emit.
 */
export function textFromBlocks(content: unknown, wanted: (type: string) => boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		const type = typeof b.type === "string" ? b.type : "text";
		if (wanted(type) && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/** Stringify a tool result payload, which both formats leave loosely typed. */
export function toolOutputText(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function emptyStats(): ConversationStats {
	return {
		turns: 0,
		events: 0,
		sessionEvents: 0,
		messages: 0,
		toolCalls: 0,
		thinkingBlocks: 0,
		unknownRecords: 0,
		duplicateRecords: 0,
		malformedLines: 0,
		usage: emptyUsage(),
	};
}

/** Kinds that belong to the conversation itself; everything else is bookkeeping. */
const CONVERSATION_KINDS = new Set<ConversationEventKind>(["message", "thinking", "tool-call", "tool-result"]);

/** Split produced events into the conversation layer and the session layer. */
export function routeEvents(
	produced: ConversationEvent[],
	conversation: ConversationEvent[],
	session: ConversationEvent[],
): void {
	for (const event of produced) {
		(CONVERSATION_KINDS.has(event.kind) ? conversation : session).push(event);
	}
}

/** Derive the counters from the events a parser produced. */
export function summarizeEvents(
	events: ConversationEvent[],
	sessionEvents: ConversationEvent[],
	stats: ConversationStats,
): void {
	stats.events = events.length;
	stats.sessionEvents = sessionEvents.length;
	for (const event of [...events, ...sessionEvents]) {
		if (event.kind === "message") stats.messages++;
		if (event.kind === "tool-call") stats.toolCalls++;
		if (event.kind === "thinking") stats.thinkingBlocks++;
		if (event.usage) addUsage(stats.usage, event.usage);
	}
}

/**
 * Group conversation events into turns. A turn opens on a user message; anything
 * before the first one becomes the preamble, so no event is stranded. Tool
 * results arrive as `tool-result` even when the native record was a user record,
 * which is what keeps them from splitting a turn in half.
 */
export function assembleTurns(events: ConversationEvent[]): ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	let current: ConversationTurn | null = null;

	const open = (trigger: "user" | "preamble", userText?: string): ConversationTurn => {
		const turn: ConversationTurn = {
			index: turns.length,
			trigger,
			startedAt: null,
			endedAt: null,
			...(userText ? { userText } : {}),
			events: [],
			usage: emptyUsage(),
		};
		turns.push(turn);
		return turn;
	};

	for (const event of events) {
		const opensTurn = event.kind === "message" && event.role === "user";
		if (opensTurn || current == null) {
			current = opensTurn ? open("user", event.text) : open("preamble");
		}
		current.events.push(event);
		if (event.usage) addUsage(current.usage, event.usage);
		if (event.timestamp) {
			current.startedAt ??= event.timestamp;
			current.endedAt = event.timestamp;
		}
		// The turn's answer is whatever prose it ended on.
		if (event.kind === "message" && event.role === "assistant" && event.text) current.assistantText = event.text;
	}

	return turns;
}

/** First and last timestamps present on the events, in file order. */
export function timeSpanOf(events: ConversationEvent[]): { startedAt: string | null; endedAt: string | null } {
	let startedAt: string | null = null;
	let endedAt: string | null = null;
	for (const event of events) {
		if (!event.timestamp) continue;
		if (startedAt == null) startedAt = event.timestamp;
		endedAt = event.timestamp;
	}
	return { startedAt, endedAt };
}

/**
 * Split a JSONL body into records, tolerating a truncated final line: a live
 * session may be appending to the very file being read, so a half-written last
 * line is normal input, not corruption.
 */
export interface JsonlScan {
	records: Record<string, unknown>[];
	malformedLines: number;
	/** The last line was unparseable and unterminated — almost certainly a live write. */
	truncatedTail: boolean;
}

export function scanJsonl(body: string): JsonlScan {
	const lines = body.split("\n");
	const endsWithNewline = body.endsWith("\n");
	const records: Record<string, unknown>[] = [];
	let malformedLines = 0;
	let truncatedTail = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// An unparseable *final* line of a file with no trailing newline is a
			// partial append, not a malformed record.
			if (i === lines.length - 1 && !endsWithNewline) truncatedTail = true;
			else malformedLines++;
			continue;
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			records.push(parsed as Record<string, unknown>);
		} else {
			malformedLines++;
		}
	}

	return { records, malformedLines, truncatedTail };
}
