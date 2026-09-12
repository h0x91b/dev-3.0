import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
import { transcriptFilesForWorktree } from "./conversation-search";
import { conversationDumpDir, parseTranscriptFile } from "./conversation-parse";
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
 * **Listing is separate from loading, and that is the whole performance story.**
 * A task can own six sessions and 79 MB of transcript; the picker only needs a
 * name and a date, so the list comes from file names and `stat`, and exactly one
 * file — the selected session — is ever opened and parsed. Parsing everything to
 * build the list is what made the first read of a large task take 20.6 s.
 *
 * Nothing is cached: a parse of one file is milliseconds, while holding parsed
 * transcripts of several tasks in the main process would cost hundreds of
 * megabytes for a panel the user opens occasionally.
 */

const log = createLogger("task-conversation");

/** Transcript kinds the parser layer understands. Gemini is found but not parsed. */
const PARSEABLE_KINDS = new Set<string>(["claude", "codex"]);

/** A session in the list, plus how to get its turns when it is the selected one. */
interface SessionRef {
	info: TaskConversationSessionInfo;
	load: () => LoadedConversation | null;
}

interface LoadedConversation {
	turns: TurnLike[];
	model: string | null;
	fidelity: "full" | "partial";
}

/** Where this task's files live, whether or not it still has a worktree. */
function taskWorkingDir(project: Project, task: Task): string {
	if (project.kind === "virtual") return task.opsWorkDir?.trim() || virtualWorkDir(project, task);
	return task.worktreePath ?? `${taskDir(project, task)}/worktree`;
}

function statOf(path: string): { mtime: string | null; bytes: number } {
	try {
		const stat = statSync(path);
		return { mtime: new Date(stat.mtimeMs).toISOString(), bytes: stat.size };
	} catch {
		return { mtime: null, bytes: 0 };
	}
}

/**
 * The session id without opening the file: both stores put it in the name —
 * Claude's transcript is `<sessionId>.jsonl`, a dump is `<source>-<sessionId>.json`,
 * and Codex's rollout name ends with its own uuid.
 */
function sessionIdFromName(fileName: string, source: string): string | null {
	const stem = fileName.replace(/\.(jsonl|json)$/, "");
	const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	if (uuid) return uuid[0];
	const prefix = `${source}-`;
	if (!stem.startsWith(prefix)) return null;
	// `conversationDumpName` writes this literal when the transcript had no id.
	const id = stem.slice(prefix.length);
	return id === "no-session" ? null : id;
}

/** Native transcripts on disk for this task's working directory — named, not parsed. */
function liveSessions(workingDir: string): SessionRef[] {
	let files: { kind: string; path: string }[];
	try {
		// A worktree that is gone is the normal case for a completed task.
		if (!statSync(workingDir).isDirectory()) return [];
		files = transcriptFilesForWorktree(workingDir, homedir());
	} catch {
		return [];
	}
	const sessions: SessionRef[] = [];
	for (const file of files) {
		if (!PARSEABLE_KINDS.has(file.kind)) continue;
		const source = file.kind as ConversationSource;
		const name = file.path.slice(file.path.lastIndexOf("/") + 1);
		const { mtime, bytes } = statOf(file.path);
		const sessionId = sessionIdFromName(name, source);
		sessions.push({
			info: {
				key: `${source}:live:${sessionId ?? file.path}`,
				source,
				sessionId,
				lastActivityAt: mtime,
				bytes,
				origin: "live",
			},
			load: () => {
				const parsed = parseTranscriptFile(file.path, source);
				if (!parsed) return null;
				return { turns: parsed.turns, model: parsed.model, fidelity: parsed.fidelity.level };
			},
		});
	}
	return sessions;
}

/** dev3's own dumps, written once when the task reached a terminal status. */
function archivedSessions(project: Project, task: Task): SessionRef[] {
	const dir = conversationDumpDir(taskDir(project, task));
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names.map((name) => {
		const path = `${dir}/${name}`;
		const source: ConversationSource = name.startsWith("codex-") ? "codex" : "claude";
		const { mtime, bytes } = statOf(path);
		const sessionId = sessionIdFromName(name, source);
		return {
			info: {
				key: `${source}:archived:${sessionId ?? path}`,
				source,
				sessionId,
				lastActivityAt: mtime,
				bytes,
				origin: "archived" as const,
			},
			load: () => {
				let dump: ConversationDump;
				try {
					dump = JSON.parse(readFileSync(path, "utf-8")) as ConversationDump;
				} catch {
					return null;
				}
				if (!Array.isArray(dump.turns)) return null;
				return {
					turns: dump.turns.map((turn) => ({
						index: turn.index,
						startedAt: turn.startedAt ?? null,
						events: turn.events ?? [],
					})),
					model: dump.model ?? null,
					fidelity: dump.fidelity?.level === "partial" ? "partial" : "full",
				};
			},
		};
	});
}

function sortKey(info: TaskConversationSessionInfo): number {
	const parsed = info.lastActivityAt ? Date.parse(info.lastActivityAt) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every session of one task, newest first, without opening a transcript. A live
 * transcript wins over its own archived copy: same conversation, more of it.
 */
export function taskConversationSessions(project: Project, task: Task): SessionRef[] {
	const live = liveSessions(taskWorkingDir(project, task));
	const liveIds = new Set(live.map((session) => session.info.sessionId).filter(Boolean));
	const archived = archivedSessions(project, task).filter(
		(session) => !session.info.sessionId || !liveIds.has(session.info.sessionId),
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
	const listedAt = Date.now();
	const sessions = taskConversationSessions(project, task);
	const listMs = Date.now() - listedAt;

	const selected = params.sessionKey
		? (sessions.find((session) => session.info.key === params.sessionKey) ?? null)
		: (sessions[0] ?? null);
	const loadedAt = Date.now();
	const loaded = selected?.load() ?? null;
	const page = loaded
		? pageOfTurns(loaded.turns, { before: params.before, limit: params.limit })
		: { views: [], firstIndex: 0 };

	log.info("Read task conversation", {
		taskId: task.id.slice(0, 8),
		sessions: sessions.length,
		turns: page.views.length,
		listMs,
		loadMs: Date.now() - loadedAt,
		bytes: selected?.info.bytes ?? 0,
	});
	return {
		sessions: sessions.map((session) => session.info),
		sessionKey: selected?.info.key ?? null,
		turns: page.views,
		totalTurns: loaded?.turns.length ?? 0,
		firstIndex: page.firstIndex,
		model: loaded?.model ?? null,
		...(loaded ? { fidelity: loaded.fidelity } : {}),
	};
}
