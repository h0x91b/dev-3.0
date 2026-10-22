import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FileLeaseTable, type FileLeaseConflict } from "../shared/file-leases";
import { getTaskTitle, TERMINAL_STATUSES, type Project, type Task } from "../shared/types";
import * as data from "./data";
import { createLogger } from "./logger";
import { taskFolderIsShared } from "./task-sessions";

const log = createLogger("file-leases");
const table = new FileLeaseTable();

/**
 * One spelling per file: symlinks resolved (through the parent when the file
 * does not exist yet, as for a Write), and case folded where the filesystem
 * ignores case.
 */
export function fileLeaseKey(path: string, platform: string = process.platform): string {
	let resolved = path;
	try {
		resolved = realpathSync(path);
	} catch {
		try {
			resolved = join(realpathSync(dirname(path)), basename(path));
		} catch {
			// A path that is not on disk at all keeps its own spelling.
		}
	}
	return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** The holder still runs: a To Do, completed or cancelled task holds nothing. */
async function holderTask(projectId: string, taskId: string): Promise<Task | null> {
	try {
		const task = await data.getTask(await data.getProject(projectId), taskId);
		return task.status === "todo" || TERMINAL_STATUSES.includes(task.status) ? null : task;
	} catch {
		return null;
	}
}

/**
 * Claim `path` for `task`. Returns the conflict when another live task holds it,
 * null otherwise. A task in its own worktree never competes, so it claims nothing.
 */
export async function claimFileForTask(project: Project, task: Task, path: string, now: number = Date.now()): Promise<FileLeaseConflict | null> {
	if (!taskFolderIsShared(task.worktreePath)) return null;
	const key = fileLeaseKey(path);
	const result = table.claim(key, task.id, project.id, now);
	if (result.granted) return null;

	const holder = await holderTask(result.holder.projectId, result.holder.taskId);
	if (!holder) {
		table.releaseTask(result.holder.taskId);
		table.claim(key, task.id, project.id, now);
		return null;
	}
	log.info("Refused an edit: another task holds the file", {
		taskId: task.id.slice(0, 8),
		holderTaskId: holder.id.slice(0, 8),
	});
	return {
		path,
		fileName: basename(path),
		holderTaskId: holder.id,
		holderSeq: holder.seq,
		holderTitle: getTaskTitle(holder),
		minutesLeft: Math.max(1, Math.ceil((result.expiresAt - now) / 60_000)),
	};
}
