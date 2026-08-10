/**
 * Oversized agent messages become a file plus a pointer.
 *
 * A pane is typed into, not written to: on tmux the whole command list rides one
 * 16 KiB frame and the text is hex-encoded at 3 bytes per byte, so a few thousand
 * bytes is the physical ceiling — see `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`. Rather
 * than reject a long message (or chop it into chunks that can half-arrive), the body
 * is written next to the task and the agent is told to read it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES, type Task } from "../shared/types";
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
