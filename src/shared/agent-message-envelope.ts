import type { AgentMessageSource } from "./types";

/**
 * Wrap a cross-task agent message in a pseudo-XML envelope so the receiving
 * agent immediately sees the text came from another task's agent (not from the
 * human) and knows the exact command to answer with.
 */
export function wrapAgentMessage(text: string, source: AgentMessageSource): string {
	const lines = [
		"<dev3-ai-message>",
		`<from-task>seq:${source.seq}</from-task>`,
	];
	if (source.title) lines.push(`<from-title>${escapeXmlText(source.title)}</from-title>`);
	lines.push(
		`<reply-with>dev3 message --task seq:${source.seq} "your reply"</reply-with>`,
		"<message>",
		text,
		"</message>",
		"</dev3-ai-message>",
	);
	return lines.join("\n");
}

/** Minimal escaping for the single-line metadata tags (the body stays verbatim). */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
