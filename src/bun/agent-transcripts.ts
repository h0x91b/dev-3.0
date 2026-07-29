import { existsSync, readdirSync, statSync } from "node:fs";
import { resolveUserHome } from "../shared/user-home";
import { getAgentAdapter } from "../shared/agent-adapters/registry";

/**
 * Verifies a stored agent session id against the transcripts actually on disk
 * before dev3 spends it on `--resume`.
 *
 * dev3 mints a session id at fresh launch and persists it as the task's resume
 * pointer. That pointer can go stale while the conversation itself survives:
 * the agent process owns the id we assigned, but its transcript may end up in a
 * different file (e.g. the user resumes another conversation from inside the
 * session). Resuming a dead id is a hard failure — the agent exits non-zero and
 * the pane dies — even though a perfectly good transcript sits next to it. See
 * decision 180.
 */

/** Resume pointer to actually use, after checking it against the store. */
export interface ResumeTarget {
	/** Id for `--resume`, or null to let the agent pick its own latest session. */
	sessionId: string | null;
	/** The stored id had no transcript, so this replaces it (worth logging). */
	substituted: boolean;
}

/** Session ids that have a transcript for this worktree, newest first. */
export function listResumableSessionIds(
	agentCmd: string,
	worktreePath: string,
	home: string = resolveUserHome(),
): string[] {
	const store = getAgentAdapter(agentCmd).transcriptStore?.(worktreePath, home) ?? null;
	if (!store) return [];
	return sessionIdsNewestFirst(store.dir, store.ext);
}

/**
 * Pick the session id to resume. Falls back to the newest transcript when the
 * stored id is dead, and to the agent's own "latest" when the store is empty.
 * Passes the stored id through untouched whenever it cannot be verified, so an
 * unknown store never makes resume worse than not checking at all.
 */
export function resolveResumableSessionId(
	agentCmd: string,
	worktreePath: string,
	storedSessionId: string | null | undefined,
	home: string = resolveUserHome(),
): ResumeTarget {
	const stored = storedSessionId ?? null;
	const store = getAgentAdapter(agentCmd).transcriptStore?.(worktreePath, home) ?? null;
	if (!store || !existsSync(store.dir)) return { sessionId: stored, substituted: false };
	if (!stored) return { sessionId: null, substituted: false };

	const ids = sessionIdsNewestFirst(store.dir, store.ext);
	if (ids.includes(stored)) return { sessionId: stored, substituted: false };
	return { sessionId: ids[0] ?? null, substituted: true };
}

function sessionIdsNewestFirst(dir: string, ext: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(ext) && f.length > ext.length);
	} catch {
		return [];
	}
	return names
		.map((name) => ({ id: name.slice(0, -ext.length), mtimeMs: mtimeMsOf(`${dir}/${name}`) }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.map((entry) => entry.id);
}

function mtimeMsOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
