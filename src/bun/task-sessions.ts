import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../shared/types";
import { isDev3OwnedFolder } from "../shared/agent-hooks";
import { taskDir } from "./git";
import { createLogger } from "./logger";

/**
 * Which agent sessions belong to a task whose folder other tasks share.
 *
 * A worktree holds one task's transcripts, so everything found under it is that
 * task's. A project folder with its git workflow off, or an Operations task in a
 * folder the user chose, holds every task's sessions and the user's own. Readers
 * there keep only the sessions this file lists, plus the ids on the task's panes.
 * The hooks report each session id as it appears, which covers `/clear` and
 * compaction, where Claude starts a new transcript under a new id.
 */

const log = createLogger("task-sessions");
const FILE_NAME = "agent-sessions.json";
const MAX_SESSIONS = 200;

/** Ids already on disk, so the steady state of a hook costs no read or write. */
const known = new Map<string, Set<string>>();

function sessionsFile(project: Project, task: Task): string {
	return `${taskDir(project, task)}/${FILE_NAME}`;
}

function readIds(path: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { sessionIds?: unknown };
		return Array.isArray(parsed.sessionIds) ? parsed.sessionIds.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

/** True when the task's working folder may hold other tasks' transcripts. */
export function taskFolderIsShared(workingDir: string | null | undefined): boolean {
	return !!workingDir && !isDev3OwnedFolder(workingDir);
}

/** Record a session id a hook reported for this task. Never throws. */
export function rememberTaskSession(project: Project, task: Task, sessionId: string | null): void {
	if (!sessionId) return;
	try {
		if (!taskFolderIsShared(task.worktreePath)) return;
		const path = sessionsFile(project, task);
		let ids = known.get(path);
		if (ids?.has(sessionId)) return;
		ids = new Set(readIds(path));
		if (!ids.has(sessionId)) {
			ids.add(sessionId);
			const kept = [...ids].slice(-MAX_SESSIONS);
			ids = new Set(kept);
			mkdirSync(taskDir(project, task), { recursive: true });
			const temp = `${path}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify({ sessionIds: kept }, null, 2) + "\n", "utf-8");
			renameSync(temp, path);
		}
		known.set(path, ids);
	} catch (err) {
		log.warn("Could not record the task's session id (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}

/**
 * The session ids a reader of `workingDir` should keep for this task, or null
 * when the folder is the task's own and every transcript in it belongs to it.
 */
export function taskSessionIds(project: Project, task: Task, workingDir: string | null | undefined): string[] | null {
	if (!taskFolderIsShared(workingDir)) return null;
	const ids = new Set(readIds(sessionsFile(project, task)));
	for (const pane of task.sessionState?.panes ?? []) {
		if (pane.sessionId) ids.add(pane.sessionId);
	}
	return [...ids];
}

/** Test seam. */
export function _resetTaskSessionsCacheForTests(): void {
	known.clear();
}
