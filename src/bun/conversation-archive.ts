import type { Project, Task } from "../shared/types";
import { taskDir, virtualWorkDir } from "./git";
import {
	conversationDumpDir,
	conversationDumpName,
	parseWorktreeConversations,
	writeConversationDump,
} from "./conversation-parse";
import { createLogger } from "./logger";

/**
 * Archiving a task's conversations when the task reaches a terminal status.
 *
 * Two clocks make this the last chance: Claude Code prunes its own transcripts on
 * a retention window (~30 days by default), and dev3 nulls the worktree path the
 * store was keyed on the moment a task completes. A conversation dev3 never
 * copied is a conversation dev3 loses.
 *
 * Written exactly once per terminal transition, and deliberately NOT after every
 * agent reply: parsing is cheap (the largest transcript on this machine, 138 MB,
 * parses in ~190 ms) but writing is not — that same conversation projects to a
 * 4 MB dump, and the largest dump measured was 15 MB. A per-reply rewrite would
 * spend megabytes per turn to save milliseconds per read.
 */

const log = createLogger("conversation-archive");

/**
 * Dump every parseable conversation of a task about to go terminal. Returns the
 * files written. Never throws: an archive is not worth failing a completion over.
 */
export async function dumpTerminalTaskConversations(
	project: Project,
	task: Task,
	derivedWorktreePath: string | null = null,
): Promise<string[]> {
	const workingDir = task.worktreePath
		?? derivedWorktreePath
		?? (project.kind === "virtual" ? task.opsWorkDir?.trim() || virtualWorkDir(project, task) : null);
	if (!workingDir) return [];

	const written: string[] = [];
	try {
		const parsed = parseWorktreeConversations(workingDir);
		if (parsed.length === 0) return [];
		const dir = conversationDumpDir(taskDir(project, task));
		for (const { conversation } of parsed) {
			written.push(await writeConversationDump(dir, conversationDumpName(conversation), conversation));
		}
		log.info("Archived task conversations", {
			taskId: task.id.slice(0, 8),
			files: written.length,
		});
	} catch (err) {
		log.warn("Could not archive task conversations", { taskId: task.id.slice(0, 8), error: String(err) });
	}
	return written;
}
