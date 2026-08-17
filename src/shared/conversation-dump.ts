/**
 * What a dump keeps, and what it refuses to keep twice.
 *
 * Parsing stays lossless in memory; the dump is a *projection* of it. The split
 * matters because the two have different jobs: the parsed conversation feeds
 * renderers and analysis, while the dump is a durable memo that must survive next
 * to a repository — not replace it.
 *
 * The budgets below were not guessed. Three agents with no prior context were
 * each given the same conversation dumped at a different truncation budget and
 * asked to take the work over cold. They scored 8/10 (full, 1.09 MB), 7/10
 * (1 KB cap, 765 KB) and 6.5/10 (100 B cap, 589 KB) — and all three independently
 * concluded the same thing: the dump is an excellent specification and a poor
 * codebase, so a real takeover starts by opening the git branch. That flat curve
 * is what justifies cutting hard. All three also named the same dead weight:
 * the session-event array, per-event token usage, and event ids.
 */

import {
	emptyUsage,
	type ConversationEvent,
	type ConversationTurn,
	type ParsedConversation,
} from "./conversation-model";

/** Per-role truncation budgets, in characters. */
export interface DumpBudget {
	/** Shell commands and file paths. Generous: an absolute worktree path alone
	 *  eats ~92 characters, and a decapitated command cannot be understood at all. */
	action: number;
	/** Tool output and file contents. Tight: re-derivable from the repo or by
	 *  re-running, and two values alone held 37% of all output bytes. */
	payload: number;
}

export const DEFAULT_DUMP_BUDGET: DumpBudget = { action: 2000, payload: 1000 };

/**
 * The only session-layer records that reach a dump. Everything else in that layer
 * is environment or plumbing — measured across five real sessions: 810
 * `hook_success` records holding 301 KB of `{"stdout":"{}\n","exitCode":0}`, a
 * 158 KB skill catalogue re-listed five times, tool/MCP/agent catalogues, the
 * output style logged 293 times, `last-prompt` duplicating the prompt, and
 * `ai-title` which is already the `title` field. None of it says anything about
 * the work, and none of it is worth a per-type counter either.
 */
const KEPT_SESSION_TYPES = new Set([
	// The user edited a file outside the agent — the next agent must know.
	"edited_text_file",
	// A hook failed. A silently swallowed error is the worst kind.
	"hook_non_blocking_error",
	// Compaction boundary: where the agent's own context was cut.
	"context_compacted",
	"compacted",
]);

/** The dump's own shape: a projection of ParsedConversation, not the same type. */
export interface ConversationDump extends Omit<ParsedConversation, "turns" | "sessionEvents"> {
	turns: DumpTurn[];
	/** The handful of session records that change a takeover decision, with their
	 *  content: a file edited outside the agent, a hook that failed, a compaction. */
	notices: ConversationEvent[];
	/** What this projection dropped, so a reader is never misled about fidelity. */
	dumpPolicy: {
		budget: DumpBudget;
		/** Characters removed by truncation. */
		truncatedChars: number;
		/** Values that were truncated. */
		truncatedValues: number;
		/** Fields omitted because another field already holds the same bytes. */
		omittedDuplicates: string[];
		/** Session-layer records discarded as environment or plumbing. */
		discardedSessionEvents: number;
	};
}

type DumpTurn = Omit<ConversationTurn, "events"> & { events: ConversationEvent[] };

interface Cutter {
	cut(value: string, budget: number): string;
	chars: number;
	values: number;
}

function makeCutter(): Cutter {
	const state: Cutter = {
		chars: 0,
		values: 0,
		cut(value, budget) {
			if (value.length <= budget) return value;
			state.chars += value.length - budget;
			state.values++;
			return `${value.slice(0, budget)}…[+${value.length - budget} chars]`;
		},
	};
	return state;
}

/** Truncate every string inside an arbitrary tool payload. */
function cutDeep(value: unknown, budget: number, cutter: Cutter): unknown {
	if (typeof value === "string") return cutter.cut(value, budget);
	if (Array.isArray(value)) return value.map((item) => cutDeep(item, budget, cutter));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = cutDeep(item, budget, cutter);
		}
		return out;
	}
	return value;
}

/**
 * Project one event for the dump: drop per-event usage (no reader has ever
 * needed it — it survives in `turns[].usage` and `stats.usage`), drop the
 * canonical body that duplicates the native input byte for byte, and apply the
 * per-role budgets.
 */
function projectEvent(event: ConversationEvent, budget: DumpBudget, cutter: Cutter): ConversationEvent {
	const { usage: _usage, tool, ...rest } = event;
	if (!tool) return rest;

	const canonical = tool.canonical
		? {
			...tool.canonical,
			// `body` is a substring of `input` in 98% of calls; keeping both spends
			// the budget twice on the same bytes.
			body: undefined,
			command: tool.canonical.command ? cutter.cut(tool.canonical.command, budget.action) : undefined,
			path: tool.canonical.path ? cutter.cut(tool.canonical.path, budget.action) : undefined,
		}
		: undefined;

	return {
		...rest,
		tool: {
			...tool,
			input: tool.input === undefined ? undefined : cutDeep(tool.input, budget.payload, cutter),
			output: tool.output === undefined ? undefined : cutter.cut(tool.output, budget.payload),
			canonical,
		},
	};
}

/** Build the dump projection of a parsed conversation. */
export function projectConversationForDump(
	parsed: ParsedConversation,
	budget: DumpBudget = DEFAULT_DUMP_BUDGET,
): ConversationDump {
	const cutter = makeCutter();

	const turns: DumpTurn[] = parsed.turns.map((turn) => {
		// `assistantText` is byte-identical to message events of the same turn; a
		// reader derives it with `turnAssistantText()` instead.
		const { assistantText: _assistantText, ...rest } = turn;
		return { ...rest, events: turn.events.map((event) => projectEvent(event, budget, cutter)) };
	});

	const notices = parsed.sessionEvents
		.filter((event) => KEPT_SESSION_TYPES.has(sessionRecordType(event)))
		.map((event) => projectEvent(event, budget, cutter));

	const { turns: _t, sessionEvents: _s, ...header } = parsed;
	return {
		...header,
		turns,
		notices,
		dumpPolicy: {
			budget,
			truncatedChars: cutter.chars,
			truncatedValues: cutter.values,
			omittedDuplicates: ["turns[].assistantText", "events[].tool.canonical.body", "events[].usage"],
			discardedSessionEvents: parsed.sessionEvents.length - notices.length,
		},
	};
}

/** The record type a session event stands for, however the parser labelled it. */
export function sessionRecordType(event: ConversationEvent): string {
	const meta = event.meta ?? {};
	for (const key of ["attachmentType", "recordType", "eventType"]) {
		const value = meta[key];
		if (typeof value === "string" && value) return value;
	}
	return "unknown";
}

/** The turn's closing prose reply, derived rather than stored twice. */
export function turnAssistantText(turn: { events: ConversationEvent[] }): string | undefined {
	for (let i = turn.events.length - 1; i >= 0; i--) {
		const event = turn.events[i];
		if (event.kind === "message" && event.role === "assistant" && event.text) return event.text;
	}
	return undefined;
}

/** Usage totals of a turn, for readers of a dump that no longer stores per-event usage. */
export function turnUsage(turn: ConversationTurn): ConversationTurn["usage"] {
	return turn.usage ?? emptyUsage();
}
