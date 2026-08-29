import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Task } from "../shared/types";
import type { HandoffPreview } from "../shared/conversation-handoff-model";
import { renderHandoffFile, type RenderTarget } from "../shared/conversation-render";
import { conversationDumpDir, parseWorktreeConversations } from "./conversation-parse";
import { atomicWriteFile } from "./atomic-write";

/**
 * Handing one task's live conversation to a different agent.
 *
 * A cross-client resume does not exist and cannot be built: `--resume` reads only
 * its own store, Claude signs its reasoning blocks, and the two tool sets do not
 * intersect. So this is a *retelling* — `renderHandoffFile` writes it, and the new
 * agent is told where to read it.
 *
 * Delivery is a file plus a one-line pointer, never the text itself: the retelling
 * runs to tens of thousands of characters, and pane input silently truncates long
 * bodies. The file also outlives the pane, so the takeover can be re-read.
 */

export interface PreparedHandoff extends HandoffPreview {
	path: string;
	/** Characters actually written, after the file budget trimmed the tail to fit. */
	chars: number;
}

/** Where a task's handoff files live: beside its dumps, in the durable container. */
function handoffDir(worktreePath: string): string {
	return conversationDumpDir(dirname(worktreePath));
}

/**
 * The conversation a handoff would retell: the task's most recently written
 * transcript. Null when the task has no worktree, or nothing parseable ran in it.
 */
export function previewTaskHandoff(task: Task, options: { home?: string } = {}): HandoffPreview | null {
	if (!task.worktreePath) return null;
	const home = options.home ?? homedir();
	const [newest] = parseWorktreeConversations(task.worktreePath, { home });
	if (!newest) return null;
	const { conversation } = newest;
	return {
		source: conversation.source,
		sessionId: conversation.sessionId,
		turns: conversation.stats.turns,
		toolCalls: conversation.stats.toolCalls,
		fidelity: conversation.fidelity.level,
	};
}

/**
 * Write the retelling of this task's newest conversation and return where it went.
 *
 * The filename carries the source and its session, so a task handed over twice
 * keeps both files and a repeat of the same session overwrites its own.
 */
export async function prepareTaskHandoff(
	task: Task,
	options: { home?: string; target?: RenderTarget } = {},
): Promise<PreparedHandoff | null> {
	if (!task.worktreePath) return null;
	const home = options.home ?? homedir();
	const [newest] = parseWorktreeConversations(task.worktreePath, { home });
	if (!newest) return null;

	const { conversation } = newest;
	const text = renderHandoffFile(conversation, { target: options.target ?? "claude" });
	const dir = handoffDir(task.worktreePath);
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/handoff-${conversation.source}-${conversation.sessionId ?? "no-session"}.md`;
	await atomicWriteFile(path, text);

	return {
		path,
		source: conversation.source,
		sessionId: conversation.sessionId,
		turns: conversation.stats.turns,
		toolCalls: conversation.stats.toolCalls,
		fidelity: conversation.fidelity.level,
		chars: text.length,
	};
}

/**
 * The line typed into the new agent's pane. Short by necessity and blunt on
 * purpose: the one thing that must not be misread is that the actions in the file
 * belong to a previous agent and nothing in it is still running.
 */
export function handoffPrompt(handoff: PreparedHandoff): string {
	const previous = handoff.source === "claude" ? "Claude Code" : "Codex";
	return (
		`You are taking over work that ran in ${previous}, in this same worktree. ` +
		`Read ${handoff.path} in full before anything else. ` +
		`It is a RETELLING of that conversation written by dev3, not a transcript of your own: ` +
		`prompts and replies are verbatim, tool calls are reduced to what they did, and tool output is truncated. ` +
		`You did none of it, and nothing in it is still running. ` +
		`Re-read any file you need to be sure about, then continue the work from where it stopped.`
	);
}
