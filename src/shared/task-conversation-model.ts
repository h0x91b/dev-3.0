/**
 * The bounded view of one task's own agent conversation.
 *
 * A transcript is not a message log: the largest one on this machine is 138 MB,
 * and a single turn can carry a whole file. So nothing here is "the conversation"
 * — it is a window onto it: one session at a time, a page of turns, and each
 * message clamped. Everything the window leaves out is reported rather than
 * silently dropped, because a reader who cannot tell "the agent said nothing"
 * from "we cut it" learns the wrong thing.
 *
 * The turn shape is deliberately the *intersection* of a live parse and an
 * archived dump (`conversation-dump.ts` drops `userText`/`assistantText` and
 * derives them from events), so one builder serves a running task and a
 * completed one.
 */

import { turnAssistantText, turnUserText } from "./conversation-dump";
import type { ConversationEvent, ConversationSource } from "./conversation-model";

/** Turns fetched per request. One page is a screenful plus room to scroll. */
export const TASK_CONVERSATION_PAGE = 25;

/**
 * Characters of a message shown before "Show more". The rest is already in the
 * payload, so expanding costs no round trip.
 */
export const TASK_CONVERSATION_TEXT_LIMIT = 2000;

/**
 * Cut a Markdown message for the folded preview.
 *
 * Slicing Markdown at a character index is what breaks it: half a fenced block
 * renders as prose, half a table as pipes, half an emphasis run as asterisks. So
 * the cut lands on a block boundary (a blank line) and falls back to a line
 * boundary, and an odd number of fences left open is closed. The preview is then
 * valid Markdown on its own, which also means the hidden half cannot leak out
 * through a dangling construct.
 */
export function clipMarkdown(
	text: string,
	limit = TASK_CONVERSATION_TEXT_LIMIT,
): { text: string; clipped: boolean } {
	if (text.length <= limit) return { text, clipped: false };
	const window = text.slice(0, limit);
	const block = window.lastIndexOf("\n\n");
	const line = window.lastIndexOf("\n");
	// A single block longer than the budget has no boundary to respect; cutting it
	// mid-line is still better than showing nothing, and the fence guard below
	// keeps the result parseable.
	let cut = window.slice(0, block > 0 ? block : line > 0 ? line : limit).trimEnd();
	const fences = (cut.match(/^\s*```/gm) ?? []).length;
	if (fences % 2 === 1) cut += "\n```";
	return { text: `${cut}\n\n…`, clipped: true };
}

/**
 * Hard ceiling on the characters of one message that travel at all. Measured
 * over 1 293 real messages of two large tasks: median 561, p90 898, p99 10 459,
 * longest 33 184 — so this is three times the worst case seen and a page of 25
 * turns stays tens of kilobytes. Past it the view says how much it left behind,
 * because a pasted 5 MB file must not become a 5 MB panel.
 */
export const TASK_CONVERSATION_TEXT_CEILING = 50_000;

/** Distinct tool names named on a turn before the rest become a count. */
export const TASK_CONVERSATION_TOOL_NAMES = 4;

/** Where the conversation was read from. An archive is a projection, not the file. */
export type TaskConversationOrigin = "live" | "archived";

/**
 * One session as the PICKER knows it: from the file's name and its stat, never
 * from parsing it. Listing six sessions must not cost six parses, so everything
 * that needs the file open — turn count, model, fidelity — lives on the view of
 * the session actually selected.
 */
export interface TaskConversationSessionInfo {
	/** Stable id for picking this session. Sessions of the same task can share a
	 *  source and a null session id, so the source path is the tiebreaker. */
	key: string;
	source: ConversationSource;
	sessionId: string | null;
	/** File mtime: when the agent last wrote to this session. Not its end. */
	lastActivityAt: string | null;
	/** Size on disk, so the reader can see which session is the big one. */
	bytes: number;
	origin: TaskConversationOrigin;
}

export interface TaskConversationTurnView {
	index: number;
	startedAt: string | null;
	/** The prompt that opened the turn. Absent on a preamble turn. */
	userText?: string;
	/** The agent's closing prose reply, when it produced one. */
	assistantText?: string;
	/** Characters cut from the two texts above by the budget. 0 when nothing was
	 *  cut — the reader is told how much is missing, never left to guess. */
	clippedChars: number;
	/** Tool calls inside the turn. */
	actions: number;
	/** Native tool names, first few. Identifiers — never translated. */
	tools: string[];
}

export interface TaskConversationView {
	sessions: TaskConversationSessionInfo[];
	/** The session the returned turns belong to. Null when there is none. */
	sessionKey: string | null;
	/** Oldest first, so it reads top to bottom like the conversation did. */
	turns: TaskConversationTurnView[];
	totalTurns: number;
	/** Index of the oldest turn returned. Above 0 there are earlier turns. */
	firstIndex: number;
	/** From the selected session's own file, so only it pays for the parse. */
	model?: string | null;
	/** `partial` means the parser could not map every record of the file. */
	fidelity?: "full" | "partial";
}

/** The part of a turn both a live parse and an archived dump carry. */
export interface TurnLike {
	index: number;
	startedAt: string | null;
	events: ConversationEvent[];
}

/** Cut a message to the transport ceiling, reporting what was left behind. */
export function clampText(text: string, limit = TASK_CONVERSATION_TEXT_CEILING): { text: string; clipped: number } {
	if (text.length <= limit) return { text, clipped: 0 };
	return { text: `${text.slice(0, limit)}…`, clipped: text.length - limit };
}

function toolNamesOf(events: ConversationEvent[]): { actions: number; tools: string[] } {
	const tools: string[] = [];
	let actions = 0;
	for (const event of events) {
		if (event.kind !== "tool-call") continue;
		actions++;
		const name = event.tool?.canonical?.nativeName ?? event.tool?.name;
		if (name && !tools.includes(name) && tools.length < TASK_CONVERSATION_TOOL_NAMES) tools.push(name);
	}
	return { actions, tools };
}

export function toTurnView(turn: TurnLike): TaskConversationTurnView {
	const user = turnUserText(turn);
	const assistant = turnAssistantText(turn);
	const clampedUser = user ? clampText(user) : null;
	const clampedAssistant = assistant ? clampText(assistant) : null;
	const { actions, tools } = toolNamesOf(turn.events);
	return {
		index: turn.index,
		startedAt: turn.startedAt,
		...(clampedUser ? { userText: clampedUser.text } : {}),
		...(clampedAssistant ? { assistantText: clampedAssistant.text } : {}),
		clippedChars: (clampedUser?.clipped ?? 0) + (clampedAssistant?.clipped ?? 0),
		actions,
		tools,
	};
}

/**
 * One page of turns, counted back from `before` (exclusive) or from the end.
 * Paging backwards is the only direction that makes sense here: the newest turn
 * is the one the reader came for, and "earlier" is the request they make next.
 */
export function pageOfTurns(
	turns: TurnLike[],
	options: { before?: number | null; limit?: number } = {},
): { views: TaskConversationTurnView[]; firstIndex: number } {
	const limit = Math.max(1, options.limit ?? TASK_CONVERSATION_PAGE);
	// `before` is a turn's own index, not its position in the array: a dump and a
	// live parse both number their turns, and nothing promises the two agree with
	// array order forever.
	const cut = options.before === undefined || options.before === null
		? -1
		: turns.findIndex((turn) => turn.index >= options.before!);
	const end = cut < 0 ? turns.length : cut;
	const start = Math.max(0, end - limit);
	const slice = turns.slice(start, end);
	return {
		views: slice.map(toTurnView),
		firstIndex: slice.length > 0 ? slice[0].index : 0,
	};
}
