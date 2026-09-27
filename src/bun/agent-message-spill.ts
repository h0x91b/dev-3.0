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

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES, type AgentMessageSource, type Task } from "../shared/types";
import {
	AGENT_MESSAGE_BURST_SEPARATOR,
	heldBatchSenders,
	wrapAgentMessage,
	wrapHeldBatchPointer,
} from "../shared/agent-message-envelope";
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
 * Write `content` to a fresh file under the task's `messages/`, a sibling of the git
 * worktree (a dump inside it would show up in `git status`), dying with the task
 * directory on cleanup. The name carries a random suffix and the file is created
 * exclusively: two spills in the same millisecond used to overwrite each other.
 */
async function writeTaskMessageFile(task: Task, kind: "message" | "burst", content: string): Promise<string> {
	const project = await data.getProject(task.projectId);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = `${taskDir(project, task)}/messages`;
	const path = `${dir}/${kind}-${stamp}-${randomUUID().slice(0, 8)}.md`;
	await mkdir(dir, { recursive: true });
	await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	return path;
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
	const path = await writeTaskMessageFile(task, "message", text);
	log.info("Agent message spilled to file", { taskId: task.id.slice(0, 8), bytes, path });
	return { text: spillPointerText(path, bytes), spilledPath: path };
}

/** A held backlog written to one file, and the single envelope typed in its place. */
export interface SpilledHeldBatch {
	path: string;
	pointer: string;
}

/**
 * Write a held backlog — each message's exact typed text, oldest first — to one file
 * and build the one envelope that points at it. `null` means "type them one by one as
 * before": the write failed (nobody is listening at release time, so it must not
 * throw) or not even a bare pointer fits one read.
 */
export async function spillHeldMessageBatch(task: Task, texts: readonly string[]): Promise<SpilledHeldBatch | null> {
	const context = { taskId: task.id.slice(0, 8), messages: String(texts.length) };
	let path: string;
	try {
		path = await writeTaskMessageFile(task, "burst", texts.join(AGENT_MESSAGE_BURST_SEPARATOR));
	} catch (err) {
		log.warn("held message batch could not be written; typing the messages one by one", { ...context, error: String(err) });
		return null;
	}
	const senders = heldBatchSenders(texts);
	const pointer = wrapHeldBatchPointer(texts.length, senders, path, AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);
	if (!pointer) {
		log.warn("held message batch pointer does not fit one terminal read; typing the messages one by one", { ...context, path });
		return null;
	}
	log.info("held messages batched into one file", { ...context, path, fromSeq: senders.join(",") });
	return { path, pointer };
}

/** Delete a batch file whose pointer was never typed. Already gone counts as done. */
export async function discardHeldMessageBatch(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	log.info("held message batch discarded: its pointer was never typed", { path });
}
