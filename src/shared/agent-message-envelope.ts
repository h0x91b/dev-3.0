import type { PrStatusNotice, PrWatchUntil } from "./pr-watch";
import { parseGitHubPullRequestUrl } from "./pr-status";
import { ID_PREFIX_MIN_LENGTH, type AgentMessageSource } from "./types";
import { encodeAgentHandle } from "./agent-handle";

/**
 * What stands in for the subject in a printed reply command. Obviously a slot to
 * fill rather than a subject to send — a plausible-looking one would be pasted
 * verbatim, and every reply would then carry the same line.
 */
export const REPLY_SUBJECT_PLACEHOLDER = "what your reply is about";

/**
 * What separates two envelopes typed into one input box. A burst is several whole
 * messages in one turn, and {@link wrapAgentMessage} ends without a newline — so
 * without this the receiver reads `</dev3-ai-message><dev3-ai-message>` on ONE line
 * and the boundary between two senders is gone. Measured on a real coordinator's
 * inbox: every multi-part report arrived welded (issue #1608).
 *
 * A blank line rather than one newline, because the tags alone already delimit for a
 * parser; what a reader needs is to SEE where one message stops. Also used before the
 * board snapshot that trails a burst.
 */
export const AGENT_MESSAGE_BURST_SEPARATOR = "\n\n";

/**
 * What `<reply-unavailable>` says when the record predates sender identities, or
 * whoever stamped it did not say why none was proven.
 */
export const REPLY_UNAVAILABLE_UNRECORDED = "the sending agent's identity was not recorded";

/**
 * Wrap a cross-task agent message in a pseudo-XML envelope so the receiving
 * agent immediately sees the text came from another task's agent (not from the
 * human) and knows the exact command to answer with.
 *
 * The reply command addresses the sending AGENT (`--agent`), never just its task:
 * a task-level reply may reach a sibling of the asker. With no proven sender there
 * is no reply command at all, only `<reply-unavailable>` saying why (#1809).
 *
 * `receiverProjectId` is the project of the task being written TO — it decides
 * whether the reply command needs `--project` (see {@link agentReplyCommand}).
 *
 * The whole result is what gets typed, and it must fit one pty read — the spill in
 * `agent-message-spill.ts` measures THIS output, header included, against
 * `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`.
 */
export function wrapAgentMessage(
	text: string,
	source: AgentMessageSource,
	receiverProjectId: string,
	subject?: string,
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
	if (source.role) lines.push(`<from-role>${source.role}</from-role>`);
	// The sender's own summary, shown before the body so the receiver reads what
	// this is about before reading it. Absent on a message queued before subjects
	// were required.
	if (subject) lines.push(`<subject>${escapeXmlText(subject)}</subject>`);
	lines.push(
		source.agent
			? `<reply-with>${agentReplyCommand({
				target: {
					id: source.taskId,
					seq: source.seq,
					seqShared,
					variantIndex: source.variantIndex,
					projectId: source.projectId,
				},
				fromProjectId: receiverProjectId,
				quoted: "your reply",
				agentHandle: encodeAgentHandle(source.agent),
			})}</reply-with>`
			: `<reply-unavailable>${escapeXmlText(source.agentUnavailable || REPLY_UNAVAILABLE_UNRECORDED)}</reply-unavailable>`,
		"<message>",
		text,
		"</message>",
		"</dev3-ai-message>",
	);
	return lines.join("\n");
}

/** An external sender's message as it reaches the envelope: who, and the id to reply to. */
export interface ExternalSenderStamp {
	id: string;
	label: string;
	messageId: string;
}

/**
 * Wrap a message an external sender (`dev3 message --as-sender <id>`) wrote. Same
 * tag family as {@link wrapAgentMessage}, so the receiver reads it as agent traffic
 * and not as the user. The id is self-asserted — it attributes, it does not prove.
 * The reply command lands in that sender's inbox, not in a task.
 */
export function wrapExternalSenderMessage(text: string, sender: ExternalSenderStamp, subject?: string): string {
	const lines = [
		"<dev3-ai-message>",
		`<from-sender id="${escapeXmlText(sender.id)}">${escapeXmlText(sender.label)}</from-sender>`,
		`<message-id>${sender.messageId}</message-id>`,
	];
	if (subject) lines.push(`<subject>${escapeXmlText(subject)}</subject>`);
	lines.push(
		`<reply-with>${externalSenderReplyCommand(sender.id, sender.messageId)}</reply-with>`,
		"<message>",
		neutralizeEnvelopeTags(text),
		"</message>",
		"</dev3-ai-message>",
	);
	return lines.join("\n");
}

/**
 * A sender may relay third-party text; a `</message>` inside it would close the
 * envelope and let the rest forge a `<from-task>` block. Escaping the `<` keeps it readable.
 */
function neutralizeEnvelopeTags(text: string): string {
	return text.replace(/<(?=\s*\/\s*message\b|\s*\/?\s*dev3-ai-message\b)/gi, "&lt;");
}

/** The command a task's agent runs to answer an external sender. */
export function externalSenderReplyCommand(senderId: string, messageId: string): string {
	return `dev3 message --to-sender ${senderId} --in-reply-to ${messageId} --subject "${REPLY_SUBJECT_PLACEHOLDER}" "your reply"`;
}

/**
 * Wrap text a human submitted from inside an HTML artifact. The agent published
 * that artifact, so it needs to know which one answered and which version the
 * human was looking at — a report republished twice since then asked a different
 * question. Same tag family as {@link wrapAgentMessage} on purpose.
 */
export function wrapArtifactMessage(
	text: string,
	artifact: { title: string; version: number; versionCount: number },
): string {
	return [
		"<dev3-artifact-message>",
		`<artifact-title>${escapeXmlText(artifact.title)}</artifact-title>`,
		`<artifact-version>${artifact.version} of ${artifact.versionCount}</artifact-version>`,
		"<message>",
		text,
		"</message>",
		"</dev3-artifact-message>",
	].join("\n");
}

export type PrMergedCompletion = "offered" | "not-offered" | "after-local-work";

const PR_MERGED_SENTENCE: Record<PrMergedCompletion, (prNumber: number) => string> = {
	offered: (n) => `PR #${n} merged. Wrap up now (final report, notes, report to whoever started you); dev3 offers the user task completion after your turn ends, so do not request it yourself.`,
	"not-offered": (n) => `PR #${n} merged. dev3 does not offer completion for this task; continue per your task rules.`,
	"after-local-work": (n) => `PR #${n} merged, but this worktree has uncommitted changes or commits the PR does not include; dev3 offers completion only once they are merged or dropped.`,
};

function prNoticeSentence(prNumber: number, notice: PrStatusNotice, completion: PrMergedCompletion): string {
	switch (notice.kind) {
		case "merged":
			return PR_MERGED_SENTENCE[completion](prNumber);
		case "replaced":
			return `PR #${notice.oldNumber} is no longer this branch's open PR; watch ended. Run \`dev3 pr watch\` again if you still need it.`;
		case "closed":
			return `PR #${prNumber} closed without merge.`;
		case "ci-passed":
			return `PR #${prNumber}: CI finished on ${notice.sha.slice(0, 7)}: all ${notice.totalChecks} checks GitHub listed passed.`;
		case "ci-failed":
			// No check names: they are written by whoever owns the workflow file, and this text lands in the agent's prompt.
			return `PR #${prNumber}: CI finished on ${notice.sha.slice(0, 7)}: ${notice.failedCount} of ${notice.totalChecks} checks GitHub listed failed; see \`gh pr checks ${prNumber}\`.`;
	}
}

const PR_NOTICE_SUBJECT: Record<PrStatusNotice["kind"], string> = {
	"ci-passed": "CI passed",
	"ci-failed": "CI failed",
	merged: "merged",
	closed: "closed without merge",
	replaced: "watch ended",
};

/** Only the exact `https://<host>/<owner>/<repo>/pull/<N>` shape of this PR goes into the message. */
function isPlainPullRequestUrl(url: string, prNumber: number): boolean {
	const repo = parseGitHubPullRequestUrl(url);
	return repo !== null && url === `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${prNumber}`;
}

/** The agent-traffic-log subject for a PR status message. */
export function prStatusSubject(prNumber: number, notices: readonly PrStatusNotice[]): string {
	const first = notices[0];
	if (first?.kind === "replaced") return `PR #${first.oldNumber}: ${PR_NOTICE_SUBJECT.replaced}`;
	return `PR #${prNumber}: ${first ? PR_NOTICE_SUBJECT[first.kind] : "status"}`;
}

/**
 * The message dev3 itself types into an agent's pane when a `dev3 pr watch`
 * subscription fires. Not a task talking, so no `<reply-with>`.
 *
 * Only dev3's own words, the PR number, its URL, a short SHA and check counts go
 * in. Never the PR title, a review or a comment: fork authors write those, and this
 * text lands in the agent's prompt. It must stay under
 * `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`.
 */
export function wrapPrStatusMessage(input: {
	prNumber: number;
	url: string;
	notices: readonly PrStatusNotice[];
	/** Kinds of watch that remain on the task after this message. */
	remaining: readonly PrWatchUntil[];
	/** What the merge path does next: offer completion, only post a notice, or wait for local work to land. */
	completion: PrMergedCompletion;
}): string {
	const sentences = [...new Set(input.notices.map((notice) => prNoticeSentence(input.prNumber, notice, input.completion)))];
	const lines = ["<dev3-pr-status>", ...sentences];
	if (isPlainPullRequestUrl(input.url, input.prNumber)) lines.push(input.url);
	lines.push(
		`${input.remaining.length > 0 ? `Watch until ${input.remaining.join(" and ")} stays active.` : "No watch is left."} Act per your task rules.`,
		"</dev3-pr-status>",
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
	/** Placeholder for the mandatory `--subject`; overridden only by tests. */
	subject?: string;
	/** Narrows the reply to one agent of the target task (`dev3 message --agent`). */
	agentHandle?: string;
}): string {
	const { target, fromProjectId, quoted } = opts;
	const crossProject = target.projectId != null && target.projectId !== fromProjectId;
	const scope = crossProject ? ` --project ${target.projectId!.slice(0, ID_PREFIX_MIN_LENGTH)}` : "";
	const seqShared = target.seqShared === true;
	const address = seqShared && target.variantIndex != null
		? `seq:${target.seq} --variant ${target.variantIndex}`
		: agentReplyRef(target, seqShared);
	// `--subject` is mandatory, so the printed command must carry it: a caller who
	// copy-pastes the old shape is rejected with exit 17 instead of being heard.
	const subject = opts.subject ?? REPLY_SUBJECT_PLACEHOLDER;
	const agent = opts.agentHandle ? ` --agent ${opts.agentHandle}` : "";
	return `dev3 message --task ${address}${scope}${agent} --subject "${subject}" "${quoted}"`;
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

const SENDER_REF_RE = /<from-task>([^<]+)<\/from-task>|<from-sender id="([^"]+)">/;

/** The sender address of each envelope, first-seen order, duplicates dropped; non-envelopes add nothing. */
export function heldBatchSenders(texts: readonly string[]): string[] {
	const senders: string[] = [];
	for (const text of texts) {
		const match = SENDER_REF_RE.exec(text);
		const ref = match?.[1] ?? match?.[2];
		if (ref && !senders.includes(ref)) senders.push(ref);
	}
	return senders;
}

/**
 * The one envelope typed in place of a held backlog that no longer fits one terminal
 * read. It must itself fit that read, so the sender list is cut down (`… +N more`)
 * before the path ever is; `null` when even the bare path does not fit — the caller
 * then falls back to typing the messages one turn at a time.
 */
export function wrapHeldBatchPointer(count: number, senders: readonly string[], path: string, maxBytes: number): string | null {
	const build = (shown: readonly string[]): string => {
		const hidden = senders.length - shown.length;
		const from = shown.length === 0 ? "" : ` from ${shown.join(", ")}${hidden > 0 ? `, … +${hidden} more` : ""}`;
		return [
			"<dev3-ai-message>",
			`<subject>${count} held messages in one file</subject>`,
			"<message>",
			`${count} messages${from} arrived while this pane was busy. They are in one file, oldest first; each keeps its own sender and reply command. Read it in full and act on each: ${path}`,
			"</message>",
			"</dev3-ai-message>",
		].join("\n");
	};
	for (let shown = senders.length; shown >= 0; shown -= 1) {
		const pointer = build(senders.slice(0, shown));
		if (new TextEncoder().encode(pointer).length <= maxBytes) return pointer;
	}
	return null;
}

/** Minimal escaping for the single-line metadata tags (the body stays verbatim). */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
