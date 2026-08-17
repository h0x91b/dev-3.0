import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
	detectConversationSource,
	parseConversation,
	type ParseConversationOptions,
} from "../shared/conversation-parsers";
import type { ConversationSource, ParsedConversation } from "../shared/conversation-model";
import { atomicWriteFile } from "./atomic-write";
import { transcriptFilesForWorktree } from "./conversation-search";

/**
 * Filesystem layer over the pure transcript parsers: find a worktree's native
 * transcripts, read them, and write the parsed JSON out.
 *
 * Dumps live in the task's own container directory, next to the `logs/` and
 * `diffs/` it already owns: `<worktrees>/<slug>/<taskShortId>/conversations/`.
 * That directory outlives the worktree — teardown removes only `worktree/`, never
 * its parent — so a completed task keeps its parsed conversations while a task
 * with many agents and compactions keeps its files scoped to itself. A new
 * subdirectory of a directory dev3 already owns is additive: nothing is renamed
 * or rewritten (see the on-disk invariants in AGENTS.md).
 */

/** Locator kinds the parser layer understands. Gemini is discovered but not parsed yet. */
const PARSEABLE_KINDS = new Set<string>(["claude", "codex"]);

export interface ParsedTranscript {
	conversation: ParsedConversation;
	/** File mtime, so callers can order sessions newest-first. */
	mtimeMs: number;
}

/** Parse one transcript file. Source is sniffed from the content when not given. */
export function parseTranscriptFile(
	path: string,
	source?: ConversationSource,
	options?: ParseConversationOptions,
): ParsedConversation | null {
	let body: string;
	try {
		body = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const resolved = source ?? detectConversationSource(body);
	if (!resolved) return null;
	return parseConversation(resolved, body, path, options);
}

/** Every parseable conversation belonging to one worktree, newest file first. */
export function parseWorktreeConversations(
	worktreePath: string,
	options: ParseConversationOptions & { home?: string } = {},
): ParsedTranscript[] {
	const home = options.home ?? homedir();
	const parsed: ParsedTranscript[] = [];

	for (const file of transcriptFilesForWorktree(worktreePath, home)) {
		if (!PARSEABLE_KINDS.has(file.kind)) continue;
		const conversation = parseTranscriptFile(file.path, file.kind as ConversationSource, options);
		if (!conversation) continue;
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(file.path).mtimeMs;
		} catch {
			// A transcript that vanished mid-scan still parsed; order it last.
		}
		parsed.push({ conversation, mtimeMs });
	}

	return parsed.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The task container directory that holds `worktree/`, `logs/`, `diffs/`. */
export function taskContainerDir(dev3Home: string, projectSlug: string, taskShortId: string): string {
	return `${dev3Home}/worktrees/${projectSlug}/${taskShortId}`;
}

/** Where one task's parsed conversations are kept. */
export function conversationDumpDir(taskContainer: string): string {
	return `${taskContainer}/conversations`;
}

/** Filename for one dump. The directory is already per-task, so agent + session
 *  is enough to keep every agent and every compaction of a task side by side. */
export function conversationDumpName(conversation: ParsedConversation): string {
	const session = conversation.sessionId ?? "no-session";
	return `${conversation.source}-${session}.json`;
}

/** Write one parsed conversation as pretty JSON. Returns the path written. */
export async function writeConversationDump(
	dir: string,
	fileName: string,
	conversation: ParsedConversation,
): Promise<string> {
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/${fileName}`;
	await atomicWriteFile(path, `${JSON.stringify(conversation, null, 2)}\n`);
	return path;
}
