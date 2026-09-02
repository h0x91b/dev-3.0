/**
 * Long agent messages become a file plus a pointer.
 *
 * A pane is pasted into, not written to, and the program reading it takes about one
 * KiB per read; a delivery longer than that arrives in pieces, and Claude Code
 * intermittently loses the first piece on submit (issue #1608) — see
 * `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`. Rather than paste a body that can half-arrive,
 * anything longer than one read is written next to the task and the agent is told to
 * read it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES, type AgentMessageSource, type Task } from "../shared/types";
import { wrapAgentMessage } from "../shared/agent-message-envelope";
import { utf8Length } from "../shared/pane-input";
import * as data from "./data";
import { taskDir } from "./git";
import { createLogger } from "./logger";

const log = createLogger("agent-message-spill");

export interface SpilledAgentMessage {
	/** What actually gets typed into the pane: the body, or a pointer to it. */
	text: string;
	/** The file the body was written to, or null when it travelled as text. */
	spilledPath: string | null;
}

/** Who is writing and what about — everything the envelope adds around the body. */
export interface AgentMessageEnvelope {
	source: AgentMessageSource;
	subject?: string | null;
}

/**
 * Sibling of the git worktree, never inside it — a dump under `<worktree>/` would
 * show up untracked in `git status`. Dies with the task directory on cleanup.
 */
function messageSpillPath(taskRoot: string, stamp: string): string {
	return `${taskRoot}/messages/message-${stamp}.md`;
}

/** The pointer the agent receives in place of a body that cannot be typed whole. */
function spillPointerText(path: string, bytes: number): string {
	return [
		`This message is ${bytes} bytes — longer than one terminal read can carry whole, so it was written to a file.`,
		`Read it in full and act on it: ${path}`,
	].join("\n");
}

/**
 * The bytes that would actually be typed for `text`: the agent envelope around it, or
 * the bare text for a human's own message. The pty chunks what is typed, so the header
 * counts — a short body under a long header is split all the same.
 */
function typedBytes(task: Task, text: string, envelope: AgentMessageEnvelope | null): number {
	if (!envelope) return utf8Length(text);
	return utf8Length(wrapAgentMessage(text, envelope.source, task.projectId, envelope.subject ?? undefined));
}

/**
 * Hand `text` over as-is when what would be typed fits one pty read, or write it to a
 * file and return a pointer to it. The single seam for every message path (immediate
 * `dev3 message`, a queued "Send later", and the diff viewer's send-to-agent), so the
 * three cannot drift. A write failure throws: silently typing a body that can lose its
 * head would be worse.
 */
export async function spillOversizedAgentMessage(
	task: Task,
	text: string,
	envelope: AgentMessageEnvelope | null = null,
): Promise<SpilledAgentMessage> {
	if (typedBytes(task, text, envelope) <= AGENT_MESSAGE_SPILL_THRESHOLD_BYTES) return { text, spilledPath: null };

	const bytes = utf8Length(text);
	const project = await data.getProject(task.projectId);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = messageSpillPath(taskDir(project, task), stamp);
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await writeFile(path, text, "utf8");
	log.info("Agent message spilled to file", { taskId: task.id.slice(0, 8), bytes, path });
	return { text: spillPointerText(path, bytes), spilledPath: path };
}
