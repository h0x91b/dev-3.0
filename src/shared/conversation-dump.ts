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
 * Tool payloads are then cut by *operation*, not by size — see `TOOL_POLICY`.
 * The reasoning: the next agent has the repository and `git diff`, so a file
 * edit only needs to say which file it touched, while a shell command or a
 * fetched page is nowhere else and keeps a bounded copy.
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
import type { CanonicalToolOp } from "./conversation-tools";

/**
 * What survives per canonical operation. The question is never "how many bytes"
 * but "can the next agent get this back for free?".
 *
 * The native arguments are always dropped: the canonical form already carries the
 * path, the command, the pattern or the prompt, in one shape for every agent, so
 * keeping both stores the same call twice in two dialects. What differs per
 * operation is the *result*, and whether the canonical `body` is content or an
 * identifier.
 *
 * A file operation keeps only its path — the repository and `git diff` hold what
 * the file says, and the search/replace pair inside an edit is the least useful
 * thing in a dump: it describes a state that no longer exists. A shell command is
 * the opposite: it exists nowhere else, so it is kept whole and its output
 * bounded. Anything from outside the machine — a fetched page, a web search, a
 * subagent's report — is not re-derivable at all and keeps a bounded copy.
 */
interface ToolPolicy {
	output: "drop" | "cut";
	/** The canonical `body` is a short identifier (pattern, URL, query, prompt),
	 *  not bulk content, so it is what the call *meant* and must survive. */
	keepIdentifier?: boolean;
}

const TOOL_POLICY: Record<CanonicalToolOp, ToolPolicy> = {
	// The path is the fact; the bytes are in the repo, and so is the diff.
	"file.read": { output: "drop" },
	"file.write": { output: "drop" },
	"file.edit": { output: "drop" },
	// `canonical.extra.paths` carries the files the patch named.
	"file.patch": { output: "drop" },
	"image.view": { output: "drop" },
	// A re-run gets the output back, but "what came out" often explains the next step.
	"shell.run": { output: "cut" },
	"shell.wait": { output: "cut" },
	"shell.input": { output: "cut", keepIdentifier: true },
	// The pattern is the question that was asked; results are re-runnable.
	search: { output: "cut", keepIdentifier: true },
	// Not on this machine — nothing can re-derive it.
	"web.fetch": { output: "cut", keepIdentifier: true },
	"web.search": { output: "cut", keepIdentifier: true },
	// The prompt is an instruction, and the report may be a subagent's only trace.
	"agent.spawn": { output: "cut", keepIdentifier: true },
	"agent.message": { output: "cut", keepIdentifier: true },
	"code.exec": { output: "cut", keepIdentifier: true },
	"image.generate": { output: "drop", keepIdentifier: true },
	// Intent, not payload: the plan itself lives in `canonical.extra`.
	"plan.update": { output: "drop", keepIdentifier: true },
	"user.ask": { output: "cut" },
	// Unmapped semantics — `canonical.extra` holds the arguments verbatim, because
	// guessing what is safe to drop there would lose real content.
	"mcp.call": { output: "cut" },
	unknown: { output: "cut", keepIdentifier: true },
};

/** Applied to a tool result whose call is missing, and to any op not in the table. */
const FALLBACK_POLICY: ToolPolicy = { output: "cut", keepIdentifier: true };

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
		/** Fields omitted because another field already holds the same content. */
		omittedDuplicates: string[];
		/** Session-layer records discarded as environment or plumbing. */
		discardedSessionEvents: number;
		/** Tool payloads dropped whole because the operation's own fields already say
		 *  what happened — a file edit keeps its path, not its search/replace pair. */
		droppedToolInputs: number;
		droppedToolOutputs: number;
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
	/** Payloads dropped whole by the per-operation policy, not truncated. */
	droppedInputs: number;
	droppedOutputs: number;
}

function makeCutter(): Cutter {
	const state: Cutter = {
		chars: 0,
		values: 0,
		droppedInputs: 0,
		droppedOutputs: 0,
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
/** Drop or bound a tool result, per its call's policy. */
function projectOutput(
	output: string | undefined,
	policy: ToolPolicy,
	budget: DumpBudget,
	cutter: Cutter,
): string | undefined {
	if (output === undefined) return undefined;
	if (policy.output === "drop") {
		cutter.droppedOutputs++;
		return undefined;
	}
	return cutter.cut(output, budget.payload);
}

function projectEvent(
	event: ConversationEvent,
	budget: DumpBudget,
	cutter: Cutter,
	policyByCallId: Map<string, ToolPolicy>,
): ConversationEvent {
	const { usage: _usage, tool, meta, ...rest } = event;
	// `meta` can hold a payload too — an `edited_text_file` snippet is a whole file
	// with line numbers, and nine of them were 7.6% of a real dump.
	const projectedMeta = meta ? (cutDeep(meta, budget.payload, cutter) as Record<string, unknown>) : undefined;
	if (!tool) return { ...rest, ...(projectedMeta ? { meta: projectedMeta } : {}) };

	// A result carries no canonical form of its own, so it inherits the policy of
	// the call it belongs to.
	const policy = tool.canonical
		? (TOOL_POLICY[tool.canonical.op] ?? FALLBACK_POLICY)
		: (tool.callId && policyByCallId.get(tool.callId)) || FALLBACK_POLICY;

	// The canonical form replaces the native arguments outright; only a call that
	// somehow has none keeps its own input, so nothing is ever left unsaid.
	let projectedInput: unknown;
	if (tool.input !== undefined) {
		if (tool.canonical) cutter.droppedInputs++;
		else projectedInput = cutDeep(tool.input, budget.payload, cutter);
	}
	const cut = (value: string | undefined, limit: number): string | undefined =>
		value === undefined ? undefined : cutter.cut(value, limit);
	const canonical = tool.canonical
		? {
			...tool.canonical,
			command: cut(tool.canonical.command, budget.action),
			path: cut(tool.canonical.path, budget.action),
			// Bulk content (a file body, an edit's replacement text) is dropped; a
			// short identifier — pattern, URL, query, prompt — is what the call meant.
			body: policy.keepIdentifier ? cut(tool.canonical.body, budget.action) : undefined,
			extra: tool.canonical.extra
				? (cutDeep(tool.canonical.extra, budget.payload, cutter) as Record<string, unknown>)
				: undefined,
		}
		: undefined;

	return {
		...rest,
		...(projectedMeta ? { meta: projectedMeta } : {}),
		tool: {
			...tool,
			input: projectedInput,
			output: projectOutput(tool.output, policy, budget, cutter),
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

	// Results are projected under their call's policy, and a call is not guaranteed
	// to sit in the same turn as its result, so the map is built over the whole
	// conversation first.
	const policyByCallId = new Map<string, ToolPolicy>();
	for (const turn of parsed.turns) {
		for (const event of turn.events) {
			const op = event.tool?.canonical?.op;
			const callId = event.tool?.callId;
			if (op && callId) policyByCallId.set(callId, TOOL_POLICY[op] ?? FALLBACK_POLICY);
		}
	}

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
			events.push(projectEvent(event, budget, cutter, policyByCallId));
		}
		return { ...rest, events, ...(redactedThinking ? { redactedThinking } : {}) };
	});

	const notices = parsed.sessionEvents
		.filter((event) => KEPT_SESSION_TYPES.has(sessionRecordType(event)))
		.map((event) => projectEvent(event, budget, cutter, policyByCallId));

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
				"events[].tool.input",
				"events[].tool.canonical.body",
				"events[].usage",
			],
			discardedSessionEvents: parsed.sessionEvents.length - notices.length,
			droppedToolInputs: cutter.droppedInputs,
			droppedToolOutputs: cutter.droppedOutputs,
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
