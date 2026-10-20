/**
 * Cursor Agent transcripts: role-keyed Anthropic messages, read by the Claude parser.
 * Format notes: decisions/2026/10/20/cursor-agent-transcripts.md.
 */

import type { ParsedConversation } from "../conversation-model";
import { parseMessageTranscript } from "./claude";
import type { ParseConversationOptions } from "./types";

const USER_QUERY = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/;

/** Cursor wraps every prompt in `<timestamp>`/`<user_query>` tags that are not the user's words. */
export function unwrapUserQuery(text: string): string {
	return text.match(USER_QUERY)?.[1] ?? text;
}

export function parseCursorTranscript(
	body: string,
	sourcePath: string,
	options: ParseConversationOptions = {},
): ParsedConversation {
	const parsed = parseMessageTranscript(body, sourcePath, options, "cursor");
	parsed.sessionId ??= sourcePath.slice(sourcePath.lastIndexOf("/") + 1).replace(/\.jsonl$/, "") || null;
	for (const turn of parsed.turns) {
		if (turn.userText) turn.userText = unwrapUserQuery(turn.userText);
		for (const event of turn.events) {
			if (event.role === "user" && event.kind === "message" && event.text) event.text = unwrapUserQuery(event.text);
		}
	}
	return parsed;
}
