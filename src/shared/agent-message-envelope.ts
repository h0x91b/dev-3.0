import type { AgentMessageSource } from "./types";

/**
 * Wrap a cross-task agent message in a pseudo-XML envelope so the receiving
 * agent immediately sees the text came from another task's agent (not from the
 * human) and knows the exact command to answer with.
 */
export function wrapAgentMessage(text: string, source: AgentMessageSource): string {
	const ref = agentReplyRef({ id: source.taskId, seq: source.seq, variantIndex: source.variantIndex });
	const lines = [
		"<dev3-ai-message>",
		`<from-task>${ref}</from-task>`,
	];
	if (source.title) lines.push(`<from-title>${escapeXmlText(source.title)}</from-title>`);
	lines.push(
		`<reply-with>dev3 message --task ${ref} "your reply"</reply-with>`,
		"<message>",
		text,
		"</message>",
		"</dev3-ai-message>",
	);
	return lines.join("\n");
}

/**
 * The address a peer agent must use to reach this task. Every variant of one
 * logical task shares its `seq`, so `--task seq:<N>` is rejected as ambiguous
 * there — a variant is only addressable by its own task id.
 */
export function agentReplyRef(task: { id: string; seq: number; variantIndex?: number | null }): string {
	return task.variantIndex != null ? task.id : `seq:${task.seq}`;
}

/** Minimal escaping for the single-line metadata tags (the body stays verbatim). */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
