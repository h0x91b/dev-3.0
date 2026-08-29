/**
 * The generation direction: a parsed conversation → text a *different* agent can
 * be handed.
 *
 * What this deliberately is not: a native transcript another client can `resume`.
 * That is impossible across clients — `--resume` reads only the agent's own file,
 * Claude signs its reasoning blocks so they cannot be forged, and the two agents
 * do not even share a tool set (Claude has `Read`; Codex shells out). Any
 * cross-client "continue" is therefore a retelling, and this module makes that
 * retelling as faithful as one message can be: the user's prompts verbatim, the
 * agent's replies verbatim, and its actions as canonical operations with bounded
 * output.
 */

import {
	conversationEvents,
	toolCallsOf,
	type ConversationEvent,
	type ConversationTurn,
	type ParsedConversation,
} from "./conversation-model";
import { describeToolCall, filesTouched } from "./conversation-tools";
import { turnAssistantText } from "./conversation-dump";

/** Where the retelling is going. Only the framing differs — the body is shared. */
export type RenderTarget = "markdown" | "claude" | "codex";

export interface RenderOptions {
	target?: RenderTarget;
	/** Include the agent's reasoning. Off by default: Codex only keeps a summary
	 *  and Claude's is often redacted, so it adds length without adding truth. */
	includeThinking?: boolean;
	/** Per-call cap on tool output. 0 drops output entirely, keeping only the action. */
	toolOutputLimit?: number;
	/** Keep only the last N turns (the preamble is never a turn worth keeping). */
	maxTurns?: number;
	/**
	 * Lead with the conversation's first user prompt, verbatim, before anything
	 * else. For a retelling read as a brief rather than as a log — an imported
	 * task's description, where the point has to arrive before the detail.
	 */
	leadWithFirstRequest?: boolean;
}

const DEFAULT_TOOL_OUTPUT_LIMIT = 2048;

function clamp(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…[${text.length - limit} more characters cut]`;
}

function oneLine(text: string, limit = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** The instruction that turns a transcript into a handoff. */
function preface(parsed: ParsedConversation, target: RenderTarget): string[] {
	const agent = parsed.source === "claude" ? "Claude Code" : "Codex CLI";
	if (target === "markdown") {
		return [`# Conversation from ${agent}`, ""];
	}
	return [
		`You are taking over work that ran in ${agent}. You did not perform any of the`,
		"actions below — they are a record of what the previous agent did. Nothing is",
		"still running. Read it, then continue the work from where it stopped.",
		"",
		"Tool output is truncated and file contents are not included: re-read anything",
		"you need to be sure about instead of trusting the excerpts.",
		"",
	];
}

function context(parsed: ParsedConversation): string[] {
	const lines = ["## Context", ""];
	const add = (label: string, value: string | null | undefined): void => {
		if (value) lines.push(`- ${label}: ${value}`);
	};
	add("Working directory", parsed.cwd);
	add("Git branch", parsed.gitBranch);
	add("Previous agent's model", parsed.model);
	add("Started", parsed.startedAt);
	add("Last activity", parsed.endedAt);
	const files = filesTouched(toolCallsOf(parsed));
	if (files.length > 0) {
		lines.push(`- Files it created or edited (${files.length}):`);
		for (const file of files) lines.push(`  - ${file}`);
	}
	lines.push("");
	return lines;
}

/** Result text for a call, looked up by call id rather than by position. */
function resultsByCallId(events: ConversationEvent[]): Map<string, ConversationEvent> {
	const map = new Map<string, ConversationEvent>();
	for (const event of events) {
		if (event.kind !== "tool-result") continue;
		const id = event.tool?.callId;
		if (id) map.set(id, event);
	}
	return map;
}

function renderTurn(
	turn: ConversationTurn,
	results: Map<string, ConversationEvent>,
	options: RenderOptions,
): string[] {
	const limit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
	const lines: string[] = [];

	lines.push(turn.trigger === "user" ? `## Turn ${turn.index}` : "## Before the first request");
	lines.push("");

	if (turn.userText) {
		lines.push("**The user asked:**", "", turn.userText.trim(), "");
	}

	const actions: string[] = [];
	for (const event of turn.events) {
		if (event.kind === "thinking" && options.includeThinking && event.text) {
			actions.push(`- (reasoning) ${oneLine(event.text, 400)}`);
			continue;
		}
		if (event.kind !== "tool-call") continue;
		const canonical = event.tool?.canonical;
		if (!canonical) continue;

		actions.push(`- ${describeToolCall(canonical)}`);
		// A patch or a written file is the substance of the action, not its output.
		if ((canonical.op === "file.patch" || canonical.op === "code.exec") && canonical.body) {
			actions.push("```", clamp(canonical.body, limit), "```");
		}
		const result = event.tool?.callId ? results.get(event.tool.callId) : undefined;
		const output = result?.tool?.output?.trim();
		if (output && limit > 0) {
			actions.push(result?.tool?.isError ? "  failed with:" : "  output:", "```", clamp(output, limit), "```");
		} else if (result?.tool?.isError) {
			actions.push("  (failed)");
		}
	}

	if (actions.length > 0) {
		lines.push("**What it did:**", "", ...actions, "");
	}

	// Derived, not read from a stored field — the dump omits that duplicate.
	const answer = turn.assistantText ?? turnAssistantText(turn);
	if (answer) {
		lines.push("**What it answered:**", "", answer.trim(), "");
	}

	return lines;
}

/** The first thing the user asked for, verbatim. Null when the session opened
 *  with an agent-written prompt (a compacted resume) or with no prose at all.
 *  Codex opens almost every session with injected context in the `user` role —
 *  skipped here, or every Codex import would be titled after its AGENTS.md. */
export function firstUserRequest(parsed: ParsedConversation): string | null {
	for (const turn of parsed.turns) {
		if (turn.trigger !== "user") continue;
		const opener = turn.events.find((event) => event.kind === "message" && event.role === "user");
		if (opener?.meta?.compactSummary === true || opener?.meta?.injected === true) continue;
		const text = turn.userText?.trim();
		if (text) return text;
	}
	return null;
}

/**
 * Render the whole conversation as one message. This is the "one big message"
 * path: always available, for any source agent and any target.
 */
export function renderHandoff(parsed: ParsedConversation, options: RenderOptions = {}): string {
	const target = options.target ?? "markdown";
	const results = resultsByCallId(conversationEvents(parsed));

	const substantive = parsed.turns.filter((turn) => turn.trigger === "user" || turn.events.length > 0);
	const kept = options.maxTurns && options.maxTurns > 0 ? substantive.slice(-options.maxTurns) : substantive;
	const dropped = substantive.length - kept.length;

	const lines = [...preface(parsed, target)];
	// Before the context block on purpose: whoever reads this needs the point of
	// the work before its working directory.
	const firstRequest = options.leadWithFirstRequest ? firstUserRequest(parsed) : null;
	if (firstRequest) lines.push("## The request that started this", "", firstRequest, "");
	lines.push(...context(parsed));
	if (dropped > 0) {
		lines.push(`_The first ${dropped} of ${substantive.length} turns are omitted; the rest follow._`, "");
	}
	for (const turn of kept) lines.push(...renderTurn(turn, results, options));

	lines.push(
		"---",
		"",
		`_Retold from a ${parsed.source} transcript by dev3 (parser ${parsed.parserVersion}). ` +
		`${parsed.stats.turns} turns, ${parsed.stats.toolCalls} tool calls. Fidelity: ${parsed.fidelity.level}._`,
	);
	if (parsed.fidelity.warnings.length > 0) {
		for (const warning of parsed.fidelity.warnings) lines.push(`_⚠ ${warning}_`);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Characters an imported conversation's description may occupy. It is stored in
 * `tasks.json`, which the board reads whole on every load, so the cap is the one
 * lever on that cost: 300 imported conversations at this size add ~12 MB. Lower
 * it before inventing a second storage path.
 */
export const IMPORTED_DESCRIPTION_LIMIT = 40_000;

/** How many trailing turns to try, widest first, when fitting the cap. */
const TAIL_TURN_STEPS = [60, 30, 15, 8, 4, 2, 1];

/**
 * The widest tail that fits under `limit`.
 *
 * Head plus tail, never a silent middle cut — the turn count that was dropped is
 * stated by the renderer itself, and a body still over the cap after one turn
 * ends with a marker rather than stopping mid-sentence with no notice.
 */
function fitToLimit(parsed: ParsedConversation, limit: number, base: RenderOptions): string {
	const render = (maxTurns: number): string => renderHandoff(parsed, { ...base, maxTurns });

	for (const maxTurns of TAIL_TURN_STEPS) {
		const text = render(maxTurns);
		if (text.length <= limit) return text;
	}

	const text = render(1);
	if (text.length <= limit) return text;
	// Named from the transcript, not hardcoded: a Codex import must not be told to
	// go look in Claude Code.
	const agent = parsed.source === "codex" ? "Codex" : "Claude Code";
	const marker = `\n…[${text.length - limit} more characters cut — the full conversation is still in ${agent}'s own transcript]\n`;
	return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

/**
 * The retelling that becomes an imported task's description: the user's original
 * request in full, then as much of the recent work as fits under `limit`.
 */
export function renderImportedDescription(
	parsed: ParsedConversation,
	options: { limit?: number } = {},
): string {
	return fitToLimit(parsed, options.limit ?? IMPORTED_DESCRIPTION_LIMIT, {
		target: "claude",
		leadWithFirstRequest: true,
		// A description is a brief, not an archive: an imported conversation's
		// tool output is worth a glance, never 2 KB per call.
		toolOutputLimit: 400,
	});
}

/**
 * Characters a handoff FILE may occupy.
 *
 * Three times the description cap, because nothing stores this one: it is written
 * beside the task's other artifacts and read once, by the agent taking over. About
 * 30k tokens — a long session's tail in full, still a fraction of the fresh context
 * it lands in. The parent conversation of this feature renders to 359 KB with tool
 * output dropped entirely, so an unbounded file is not an option.
 */
export const HANDOFF_FILE_LIMIT = 120_000;

/**
 * The retelling written to disk for another agent to read: the request that started
 * the work, then as much recent detail as fits. Tool output is kept at a wider limit
 * than a description gets — whoever picks this up has to know what the commands
 * actually answered, not merely that they ran.
 */
export function renderHandoffFile(
	parsed: ParsedConversation,
	options: { limit?: number; target?: RenderTarget } = {},
): string {
	return fitToLimit(parsed, options.limit ?? HANDOFF_FILE_LIMIT, {
		target: options.target ?? "claude",
		leadWithFirstRequest: true,
		toolOutputLimit: 800,
	});
}
