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
 *
 * The session layer is dropped outright rather than summarized. Its content was
 * inspected record by record: hook results, skill/tool/MCP catalogues, the output
 * style, the permission mode. All of it is Claude-Code-specific environment that
 * means nothing to another harness, and a per-type counter of known noise buys
 * nothing either — `stats.unknownRecords` is what guards against a format change.
 */

import {
	COMPACTION_RECORD_TYPE,
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
const KEPT_SESSION_TYPES = new Set<string>([
	// The user edited a file outside the agent. The only record here that means
	// anything in another harness: `git diff` shows the change but not that it was
	// somebody else's and the reason is unknown.
	"edited_text_file",
	// Where the agent's own context was cut, and how much it lost.
	COMPACTION_RECORD_TYPE,
]);

/** The dump's own shape: a projection of ParsedConversation, not the same type. */
export interface ConversationDump extends Omit<ParsedConversation, "turns" | "sessionEvents"> {
	turns: DumpTurn[];
	/** The handful of session records that change a takeover decision, with their
	 *  content: a file edited outside the agent, and a compaction with how much
	 *  context it dropped. */
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

type DumpTurn = Omit<ConversationTurn, "events" | "userText" | "assistantText"> & {
	events: ConversationEvent[];
	/** Reasoning blocks whose body the transcript withheld. They carry no text, so
	 *  they are counted here instead of costing one event each. */
	redactedThinking?: number;
};

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
	const { usage: _usage, tool, meta, ...rest } = event;
	// `meta` can hold a payload too — an `edited_text_file` snippet is a whole file
	// with line numbers, and nine of them were 7.6% of a real dump.
	const projectedMeta = meta ? (cutDeep(meta, budget.payload, cutter) as Record<string, unknown>) : undefined;
	if (!tool) return { ...rest, ...(projectedMeta ? { meta: projectedMeta } : {}) };

	// `command` and `path` are lifted out of `input`, so keeping them spends the
	// budget on bytes the reader already has. Compared against the *projected*
	// input: when truncation cut the tail off, the canonical value is kept, at the
	// roomier action budget, and stays the only complete copy.
	const projectedInput = tool.input === undefined ? undefined : cutDeep(tool.input, budget.payload, cutter);
	const inputJson = projectedInput === undefined ? "" : JSON.stringify(projectedInput);
	const alreadyInInput = (value: string | undefined): boolean => !!value && inputJson.includes(value);
	const canonical = tool.canonical
		? {
			...tool.canonical,
			// `body` is a substring of `input` in 98% of calls; keeping both spends
			// the budget twice on the same bytes.
			body: undefined,
			command: alreadyInInput(tool.canonical.command)
				? undefined
				: tool.canonical.command && cutter.cut(tool.canonical.command, budget.action),
			path: alreadyInInput(tool.canonical.path)
				? undefined
				: tool.canonical.path && cutter.cut(tool.canonical.path, budget.action),
		}
		: undefined;

	return {
		...rest,
		...(projectedMeta ? { meta: projectedMeta } : {}),
		tool: {
			...tool,
			input: projectedInput,
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
		// `userText` and `assistantText` are byte-identical to message events of the
		// same turn — together 15% of a real dump. A reader derives both with
		// `turnUserText()` / `turnAssistantText()`.
		const { userText: _userText, assistantText: _assistantText, ...rest } = turn;
		// A reasoning block the transcript withheld has no body to keep, and Claude
		// withholds all of them: 85 such events cost 12 KB of ids and timestamps to
		// say "it thought here" 85 times. One count per turn says the same.
		let redactedThinking = 0;
		const events: ConversationEvent[] = [];
		for (const event of turn.events) {
			if (event.kind === "thinking" && !event.text) {
				redactedThinking++;
				continue;
			}
			events.push(projectEvent(event, budget, cutter));
		}
		return { ...rest, events, ...(redactedThinking ? { redactedThinking } : {}) };
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
			omittedDuplicates: [
				"turns[].userText",
				"turns[].assistantText",
				"events[].tool.canonical.body",
				"events[].tool.canonical.command",
				"events[].tool.canonical.path",
				"events[].usage",
			],
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

/** The prompt that opened the turn, derived rather than stored twice. A turn
 *  whose first message is flagged `compactSummary` was opened by the agent's own
 *  handover summary, not by the user. */
export function turnUserText(turn: { events: ConversationEvent[] }): string | undefined {
	for (const event of turn.events) {
		if (event.kind === "message" && event.role === "user" && event.text) return event.text;
	}
	return undefined;
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
