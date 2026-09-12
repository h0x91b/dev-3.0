import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Project, Task } from "../shared/types";
import type { ConversationSource } from "../shared/conversation-model";
import type { ConversationDump } from "../shared/conversation-dump";
import {
	pageOfTurns,
	type TaskConversationSessionInfo,
	type TaskConversationView,
	type TurnLike,
} from "../shared/task-conversation-model";
import { taskDir, virtualWorkDir } from "./git";
import { conversationDumpDir, parseWorktreeConversations } from "./conversation-parse";
import { createLogger } from "./logger";

/**
 * Reading one task's own agent conversation, for a surface that wants to show it.
 *
 * Two stores, one answer. While a task is alive its native transcripts are on
 * disk and get parsed on demand; when it goes terminal the worktree is destroyed
 * and only dev3's own dump survives (`conversation-archive.ts`). A completed task
 * therefore answers from the archive, and the view says which of the two it read,
 * because a dump is a projection — tool payloads are cut by policy, and a reader
 * must not mistake that for what the agent actually said.
 *
 * Nothing is cached. A re-parse costs milliseconds even on a 138 MB transcript,
 * whereas holding parsed transcripts of several tasks in the main process would
 * cost hundreds of megabytes for a panel the user opens occasionally.
 */

const log = createLogger("task-conversation");

interface LoadedSession {
	info: TaskConversationSessionInfo;
	turns: TurnLike[];
}

/** Where this task's files live, whether or not it still has a worktree. */
function taskWorkingDir(project: Project, task: Task): string {
	if (project.kind === "virtual") return task.opsWorkDir?.trim() || virtualWorkDir(project, task);
	return task.worktreePath ?? `${taskDir(project, task)}/worktree`;
}

function sessionKeyOf(source: string, sessionId: string | null, path: string): string {
	return `${source}:${sessionId ?? path}`;
}

/** Native transcripts still on disk for this task's working directory. */
function liveSessions(workingDir: string): LoadedSession[] {
	return parseWorktreeConversations(workingDir).map(({ conversation }) => ({
		info: {
			key: sessionKeyOf(conversation.source, conversation.sessionId, conversation.sourcePath),
			source: conversation.source,
			sessionId: conversation.sessionId,
			model: conversation.model,
			startedAt: conversation.startedAt,
			endedAt: conversation.endedAt,
			turns: conversation.turns.length,
			origin: "live",
			fidelity: conversation.fidelity.level,
		},
		turns: conversation.turns,
	}));
}

/** dev3's own dumps, written once when the task reached a terminal status. */
function archivedSessions(project: Project, task: Task): LoadedSession[] {
	const dir = conversationDumpDir(taskDir(project, task));
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const sessions: LoadedSession[] = [];
	for (const name of files) {
		const path = `${dir}/${name}`;
		let dump: ConversationDump;
		try {
			dump = JSON.parse(readFileSync(path, "utf-8")) as ConversationDump;
		} catch {
			continue;
		}
		if (!Array.isArray(dump.turns)) continue;
		const turns: TurnLike[] = dump.turns.map((turn) => ({
			index: turn.index,
			startedAt: turn.startedAt ?? null,
			events: turn.events ?? [],
		}));
		sessions.push({
			info: {
				key: sessionKeyOf(dump.source ?? "claude", dump.sessionId ?? null, path),
				source: (dump.source ?? "claude") as ConversationSource,
				sessionId: dump.sessionId ?? null,
				model: dump.model ?? null,
				startedAt: dump.startedAt ?? null,
				endedAt: dump.endedAt ?? null,
				turns: turns.length,
				origin: "archived",
				fidelity: dump.fidelity?.level === "partial" ? "partial" : "full",
			},
			turns,
		});
	}
	return sessions;
}

function sortKey(info: TaskConversationSessionInfo): number {
	const stamp = info.endedAt ?? info.startedAt;
	const parsed = stamp ? Date.parse(stamp) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every session of one task, newest first. A live transcript wins over its own
 * archived dump: same conversation, more of it.
 */
export function taskConversationSessions(project: Project, task: Task): LoadedSession[] {
	const workingDir = taskWorkingDir(project, task);
	let live: LoadedSession[] = [];
	try {
		// A worktree that is gone is the normal case for a completed task, not an error.
		if (statSync(workingDir).isDirectory()) live = liveSessions(workingDir);
	} catch {
		live = [];
	}
	const liveSessionIds = new Set(live.map((session) => session.info.sessionId).filter(Boolean));
	const archived = archivedSessions(project, task).filter(
		(session) => !session.info.sessionId || !liveSessionIds.has(session.info.sessionId),
	);
	return [...live, ...archived].sort((a, b) => sortKey(b.info) - sortKey(a.info));
}

export interface ReadTaskConversationParams {
	/** Which session to page through. Defaults to the newest one. */
	sessionKey?: string | null;
	/** Return the turns immediately before this turn index. Omit for the newest. */
	before?: number | null;
	limit?: number;
}

export function readTaskConversation(
	project: Project,
	task: Task,
	params: ReadTaskConversationParams = {},
): TaskConversationView {
	const started = Date.now();
	const sessions = taskConversationSessions(project, task);
	const selected = params.sessionKey
		? (sessions.find((session) => session.info.key === params.sessionKey) ?? null)
		: (sessions[0] ?? null);
	const page = selected
		? pageOfTurns(selected.turns, { before: params.before, limit: params.limit })
		: { views: [], firstIndex: 0 };
	log.info("Read task conversation", {
		taskId: task.id.slice(0, 8),
		sessions: sessions.length,
		turns: page.views.length,
		ms: Date.now() - started,
	});
	return {
		sessions: sessions.map((session) => session.info),
		sessionKey: selected?.info.key ?? null,
		turns: page.views,
		totalTurns: selected?.turns.length ?? 0,
		firstIndex: page.firstIndex,
	};
}
