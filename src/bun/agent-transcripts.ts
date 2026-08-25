import { existsSync, readdirSync, statSync } from "node:fs";
import { resolveUserHome } from "../shared/user-home";
import { getAgentAdapter } from "../shared/agent-adapters/registry";
import type { AgentFamily } from "../shared/types";

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
	family?: AgentFamily,
): string[] {
	const store = getAgentAdapter(agentCmd, family).transcriptStore?.(worktreePath, home) ?? null;
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
	family?: AgentFamily,
	/** For an imported session: the directory whose store actually holds the
	 *  conversation. Checked before healing, because it is never the task's own. */
	originCwd?: string | null,
): ResumeTarget {
	const stored = storedSessionId ?? null;
	const adapter = getAgentAdapter(agentCmd, family);
	const store = adapter.transcriptStore?.(worktreePath, home) ?? null;
	if (!store || !existsSync(store.dir)) return { sessionId: stored, substituted: false };
	if (!stored) return { sessionId: null, substituted: false };

	const ids = sessionIdsNewestFirst(store.dir, store.ext);
	if (ids.includes(stored)) return { sessionId: stored, substituted: false };

	// An imported conversation stays in the store of the directory it was
	// started in: `--resume` appends to the original file and only stamps the
	// new cwd into the records. Meanwhile the agent DOES create the new
	// worktree's store directory — empty, holding just `memory/` — so the
	// early-out above sees a store that exists, finds no ids in it, and would
	// heal a perfectly good id to null (i.e. `--continue`, i.e. a brand new
	// session). Verified against Claude Code 2.1.246; see
	// decisions/2026/08/26/import-a-session-by-its-transcript.md.
	if (originCwd) {
		const origin = adapter.transcriptStore?.(originCwd, home) ?? null;
		if (origin && sessionIdsNewestFirst(origin.dir, origin.ext).includes(stored)) {
			return { sessionId: stored, substituted: false };
		}
	}

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
