/**
 * Oversized agent messages become a file plus a pointer.
 *
 * A pane is typed into, not written to: on tmux the whole command list rides one
 * 16 KiB frame and the text is hex-encoded at 3 bytes per byte, so a few thousand
 * bytes is the physical ceiling — see `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`. Rather
 * than reject a long message (or chop it into chunks that can half-arrive), the body
 * is written next to the task and the agent is told to read it.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import {
	AGENT_MESSAGE_RECEIPT_KEEP,
	AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES,
	AGENT_MESSAGE_SPILL_THRESHOLD_BYTES,
	type Task,
} from "../shared/types";
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

/**
 * Sibling of the git worktree, never inside it — a dump under `<worktree>/` would
 * show up untracked in `git status`. Dies with the task directory on cleanup.
 */
function messageSpillPath(taskRoot: string, stamp: string): string {
	return `${taskRoot}/messages/message-${stamp}.md`;
}

/** The pointer the agent receives in place of a body it cannot be typed. */
function spillPointerText(path: string, bytes: number): string {
	return [
		`This message is ${bytes} bytes — too large to type into a terminal, so it was written to a file.`,
		`Read it in full and act on it: ${path}`,
	].join("\n");
}

/**
 * Hand `text` over as-is when it fits a pane, or write it to a file and return a
 * pointer to it. The single seam for every message path (immediate `dev3 message`,
 * a queued "Send later", and the diff viewer's send-to-agent), so the three cannot
 * drift. A write failure throws: silently typing a truncated body would be worse.
 */
export async function spillOversizedAgentMessage(task: Task, text: string): Promise<SpilledAgentMessage> {
	const bytes = utf8Length(text);
	if (bytes <= AGENT_MESSAGE_SPILL_THRESHOLD_BYTES) return { text, spilledPath: null };

	const project = await data.getProject(task.projectId);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = messageSpillPath(taskDir(project, task), stamp);
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await writeFile(path, text, "utf8");
	log.info("Agent message spilled to file", { taskId: task.id.slice(0, 8), bytes, path });
	return { text: spillPointerText(path, bytes), spilledPath: path };
}

/**
 * Receipts live in their own directory, never beside the spill files: a spill is the ONLY
 * copy of a body that was never typed, and pruning must not be able to reach one.
 */
function messageReceiptDir(taskRoot: string): string {
	return `${taskRoot}/messages/receipts`;
}

/**
 * Delete every receipt past the newest {@link AGENT_MESSAGE_RECEIPT_KEEP}. The name
 * carries an ISO stamp, so lexicographic order is chronological order.
 */
async function pruneReceipts(dir: string): Promise<void> {
	const names = (await readdir(dir)).filter((name) => name.startsWith("message-")).sort();
	for (const name of names.slice(0, Math.max(0, names.length - AGENT_MESSAGE_RECEIPT_KEEP))) {
		await rm(`${dir}/${name}`, { force: true });
	}
}

/**
 * Write a long body next to the task and return that path — the message's receipt.
 *
 * The text is still typed in full; this is the copy the receiver falls back to when what
 * reached it is not what was sent. Delivery into a terminal ends in an agent CLI's input
 * layer, which dev3 does not own, and issue #1608 is a report of a head arriving missing
 * from one — so every delivery big enough to be at risk keeps a copy the receiver can name.
 *
 * `typedBytes` is the size of what will actually be typed — the envelope around `body`,
 * measured before the receipt line is added — because the receiver's input layer sees
 * the envelope, not the body: a short body under a long header is exposed all the same.
 *
 * Bounded, not accumulating: the newest {@link AGENT_MESSAGE_RECEIPT_KEEP} survive and the
 * directory dies with the task. Best-effort by design — a receipt that could not be
 * written must never cost the message itself, so a failure is logged and delivery goes on.
 */
export async function writeAgentMessageReceipt(task: Task, body: string, typedBytes: number): Promise<string | null> {
	if (typedBytes < AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES) return null;
	const bytes = utf8Length(body);
	try {
		const project = await data.getProject(task.projectId);
		// A stamp alone collides when two peers report in the same millisecond, and the
		// loser would silently overwrite the winner's receipt.
		const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
		const dir = messageReceiptDir(taskDir(project, task));
		const path = `${dir}/message-${stamp}.md`;
		await mkdir(dir, { recursive: true });
		await writeFile(path, body, "utf8");
		await pruneReceipts(dir);
		return path;
	} catch (err) {
		log.warn("Could not write the message receipt", { taskId: task.id.slice(0, 8), bytes, error: String(err) });
		return null;
	}
}
