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

/** Characters kept per message. Past this the reader opens the task itself. */
export const TASK_CONVERSATION_TEXT_LIMIT = 1200;

/** Distinct tool names named on a turn before the rest become a count. */
export const TASK_CONVERSATION_TOOL_NAMES = 4;

/** Where the conversation was read from. An archive is a projection, not the file. */
export type TaskConversationOrigin = "live" | "archived";

export interface TaskConversationSessionInfo {
	/** Stable id for picking this session. Sessions of the same task can share a
	 *  source and a null session id, so the source path is the tiebreaker. */
	key: string;
	source: ConversationSource;
	sessionId: string | null;
	model: string | null;
	startedAt: string | null;
	endedAt: string | null;
	turns: number;
	origin: TaskConversationOrigin;
	/** `partial` means the parser could not map every record of the file. */
	fidelity: "full" | "partial";
}

export interface TaskConversationTurnView {
	index: number;
	startedAt: string | null;
	/** The prompt that opened the turn. Absent on a preamble turn. */
	userText?: string;
	/** The agent's closing prose reply, when it produced one. */
	assistantText?: string;
	/** Whether either text above was cut to the character budget. */
	clamped: boolean;
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
}

/** The part of a turn both a live parse and an archived dump carry. */
export interface TurnLike {
	index: number;
	startedAt: string | null;
	events: ConversationEvent[];
}

export function clampText(text: string, limit = TASK_CONVERSATION_TEXT_LIMIT): { text: string; clamped: boolean } {
	if (text.length <= limit) return { text, clamped: false };
	return { text: `${text.slice(0, limit)}…`, clamped: true };
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
		clamped: Boolean(clampedUser?.clamped || clampedAssistant?.clamped),
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
