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

	if (turn.assistantText) {
		lines.push("**What it answered:**", "", turn.assistantText.trim(), "");
	}

	return lines;
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

	const lines = [...preface(parsed, target), ...context(parsed)];
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
