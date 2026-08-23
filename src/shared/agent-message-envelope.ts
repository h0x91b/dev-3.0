import { ID_PREFIX_MIN_LENGTH, type AgentMessageSource } from "./types";

/**
 * Wrap a cross-task agent message in a pseudo-XML envelope so the receiving
 * agent immediately sees the text came from another task's agent (not from the
 * human) and knows the exact command to answer with.
 *
 * `receiverProjectId` is the project of the task being written TO — it decides
 * whether the reply command needs `--project` (see {@link agentReplyCommand}).
 */
export function wrapAgentMessage(
	text: string,
	source: AgentMessageSource,
	receiverProjectId: string,
): string {
	const ref = agentReplyRef({ id: source.taskId, seq: source.seq, variantIndex: source.variantIndex });
	const lines = [
		"<dev3-ai-message>",
		`<from-task>${ref}</from-task>`,
	];
	if (source.title) lines.push(`<from-title>${escapeXmlText(source.title)}</from-title>`);
	lines.push(
		`<reply-with>${agentReplyCommand({
			target: { id: source.taskId, seq: source.seq, variantIndex: source.variantIndex, projectId: source.projectId },
			fromProjectId: receiverProjectId,
			quoted: "your reply",
		})}</reply-with>`,
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

/**
 * The `dev3 message` command one agent must run to reach another task.
 *
 * `--project` is added only when the two tasks live in different projects: the
 * CLI stamps the CALLER's own project onto every request it sends from inside a
 * worktree, so a bare cross-project `--task seq:<N>` is looked up on the wrong
 * board and fails as "task not found". An unknown target project (legacy queued
 * message) falls back to the bare form rather than guessing a scope.
 */
export function agentReplyCommand(opts: {
	target: { id: string; seq: number; variantIndex?: number | null; projectId?: string };
	fromProjectId: string;
	quoted: string;
}): string {
	const { target, fromProjectId, quoted } = opts;
	const crossProject = target.projectId != null && target.projectId !== fromProjectId;
	const scope = crossProject ? ` --project ${target.projectId!.slice(0, ID_PREFIX_MIN_LENGTH)}` : "";
	return `dev3 message --task ${agentReplyRef(target)}${scope} "${quoted}"`;
}

/** Minimal escaping for the single-line metadata tags (the body stays verbatim). */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
