/**
 * Parser registry. Pure: every parser takes a transcript body as text and
 * returns a ParsedConversation, so the whole format layer is unit-testable
 * without touching a disk.
 */

import type { ConversationSource, ParsedConversation } from "../conversation-model";
import { scanJsonl } from "../conversation-model";
import { parseClaudeTranscript } from "./claude";
import { parseCodexTranscript } from "./codex";
import type { ParseConversationOptions } from "./types";

export type { ParseConversationOptions } from "./types";
export { parseClaudeTranscript } from "./claude";
export { parseCodexTranscript } from "./codex";

const PARSERS: Record<ConversationSource, (body: string, path: string, o?: ParseConversationOptions) => ParsedConversation> = {
	claude: parseClaudeTranscript,
	codex: parseCodexTranscript,
};

export function parseConversation(
	source: ConversationSource,
	body: string,
	sourcePath: string,
	options?: ParseConversationOptions,
): ParsedConversation {
	return PARSERS[source](body, sourcePath, options);
}

/**
 * Identify a transcript from its first records. Codex opens with a `session_meta`
 * line; Claude records carry a `sessionId` plus a bare `type`. Content-based so a
 * file copied out of its native directory still parses.
 */
export function detectConversationSource(body: string): ConversationSource | null {
	const { records } = scanJsonl(body.slice(0, 256 * 1024));
	for (const record of records.slice(0, 20)) {
		const type = record.type;
		if (type === "session_meta" || type === "response_item" || type === "event_msg") return "codex";
		if (typeof record.sessionId === "string" && typeof type === "string") return "claude";
	}
	return null;
}
