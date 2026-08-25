import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isPathInside, transcriptsUnderPath } from "./conversation-search";
import { parseTranscriptFile } from "./conversation-parse";
import type { ConversationSource, ImportableSession } from "../shared/conversation-model";
import { DEV3_HOME } from "./paths";

export type { ImportableSession };

/**
 * Finding agent sessions that ran outside dev3 so they can be imported as tasks.
 *
 * A session is identified by its TRANSCRIPT, never by a live process: adopting a
 * running agent is impossible on both terminal backends, and the transcript
 * stores are the only discovery surface more than one harness has. See
 * decisions/2026/08/26/import-a-session-by-its-transcript.md.
 *
 * The hard rule this module enforces: a session belongs to the project that owns
 * the directory it ran in, and to no other. There is no cross-project import.
 */

/** Stores dev3 can turn into a described session. Gemini is located but not parsed. */
const IMPORTABLE_KINDS = new Set<string>(["claude", "codex"]);

export interface ListImportableOptions {
	home?: string;
	/** dev3's own root; sessions inside its worktrees are already tasks. */
	dev3Home?: string;
	/** Session ids already claimed by a task, so the picker can hide them. */
	excludeSessionIds?: Iterable<string>;
}

/**
 * Every session under `projectPath` that dev3 could import, newest first.
 *
 * Excluded, each for its own reason: stores dev3 cannot parse (nothing to show
 * the user), sessions that already ran inside a dev3 worktree (they are tasks
 * already), transcripts with no session id (nothing to resume), and any id the
 * caller says is spoken for.
 */
export function listImportableSessions(
	projectPath: string,
	options: ListImportableOptions = {},
): ImportableSession[] {
	const home = options.home ?? homedir();
	const worktreesRoot = `${options.dev3Home ?? DEV3_HOME}/worktrees`;
	const taken = new Set(options.excludeSessionIds ?? []);

	const sessions: ImportableSession[] = [];
	for (const file of transcriptsUnderPath(projectPath, home)) {
		if (!IMPORTABLE_KINDS.has(file.kind)) continue;
		if (isPathInside(file.cwd, worktreesRoot)) continue;

		const parsed = parseTranscriptFile(file.path, file.kind as ConversationSource);
		if (!parsed?.sessionId || taken.has(parsed.sessionId)) continue;

		sessions.push({
			source: parsed.source,
			sessionId: parsed.sessionId,
			path: file.path,
			cwd: parsed.cwd ?? file.cwd,
			title: parsed.title,
			gitBranch: parsed.gitBranch,
			startedAt: parsed.startedAt,
			endedAt: parsed.endedAt,
			mtimeMs: mtimeMsOf(file.path),
			turns: parsed.stats.turns,
		});
	}

	return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The label for a session row, and the imported task's title.
 *
 * Prefers the title the agent wrote itself: Claude keeps an `ai-title` record
 * that tracks what the conversation became, which beats its opening prompt (a
 * long session can open with "no i meant the other one"). Codex records no
 * title, so its first human turn is the fallback.
 */
export function sessionLabel(session: Pick<ImportableSession, "title">, firstUserText?: string): string | null {
	const title = session.title?.trim();
	if (title) return title;
	const opening = firstUserText?.trim().replace(/\s+/g, " ");
	return opening ? opening : null;
}

function mtimeMsOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
