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
	// A record queued before `seqShared` existed only knows it was a variant, so it
	// keeps the old pessimistic address rather than risking an ambiguous seq.
	const seqShared = source.seqShared ?? source.variantIndex != null;
	// `<from-task>` is an address, not a command, so it cannot carry the
	// `--variant` flag — it keeps the id whenever the seq alone is ambiguous.
	const ref = agentReplyRef({ id: source.taskId, seq: source.seq }, seqShared);
	const lines = [
		"<dev3-ai-message>",
		`<from-task>${ref}</from-task>`,
	];
	if (source.title) lines.push(`<from-title>${escapeXmlText(source.title)}</from-title>`);
	lines.push(
		`<reply-with>${agentReplyCommand({
			target: {
				id: source.taskId,
				seq: source.seq,
				seqShared,
				variantIndex: source.variantIndex,
				projectId: source.projectId,
			},
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
 * The address a peer agent must use to reach this task: the readable `seq:<N>`
 * handle unless ANOTHER task on that board still shares the seq, which is the
 * only case where the CLI rejects it as ambiguous.
 *
 * Being a variant is not that case. A group starts as several tasks sharing one
 * seq, but the user usually keeps one and drops the rest — the survivor stays
 * `variantIndex: 3` forever while its seq is perfectly unambiguous. Deciding on
 * `variantIndex` handed out a raw UUID for the common shape of a variant task,
 * so callers must count live siblings instead (`seqShared`).
 */
export function agentReplyRef(task: { id: string; seq: number }, seqShared: boolean): string {
	return seqShared ? task.id : `seq:${task.seq}`;
}

/**
 * The `dev3 message` command one agent must run to reach another task.
 *
 * `--project` is added only when the two tasks live in different projects: the
 * CLI stamps the CALLER's own project onto every request it sends from inside a
 * worktree, so a bare cross-project `--task seq:<N>` is looked up on the wrong
 * board and fails as "task not found". An unknown target project (legacy queued
 * message) falls back to the bare form rather than guessing a scope.
 *
 * A genuinely shared seq keeps its readable form too: `dev3 message` narrows a
 * variant group with `--variant <i>`, so only a shared seq on a task with no
 * variant index at all is left with a raw UUID.
 */
export function agentReplyCommand(opts: {
	target: { id: string; seq: number; seqShared?: boolean; variantIndex?: number | null; projectId?: string };
	fromProjectId: string;
	quoted: string;
}): string {
	const { target, fromProjectId, quoted } = opts;
	const crossProject = target.projectId != null && target.projectId !== fromProjectId;
	const scope = crossProject ? ` --project ${target.projectId!.slice(0, ID_PREFIX_MIN_LENGTH)}` : "";
	const seqShared = target.seqShared === true;
	const address = seqShared && target.variantIndex != null
		? `seq:${target.seq} --variant ${target.variantIndex}`
		: agentReplyRef(target, seqShared);
	return `dev3 message --task ${address}${scope} "${quoted}"`;
}

/**
 * Does another task on this board still answer to the same `seq`? The one input
 * {@link agentReplyRef} needs, and the reason it cannot be a pure function of the
 * task: only the board knows whether a variant group still has more than one
 * member.
 */
export function seqIsShared(task: { id: string; seq: number }, boardTasks: Array<{ id: string; seq: number }>): boolean {
	return boardTasks.some((t) => t.seq === task.seq && t.id !== task.id);
}

/** Minimal escaping for the single-line metadata tags (the body stays verbatim). */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
