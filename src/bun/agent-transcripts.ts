import { existsSync, readdirSync, statSync } from "node:fs";
import { resolveUserHome } from "../shared/user-home";
import { getAgentAdapter } from "../shared/agent-adapters/registry";
import type { AgentFamily } from "../shared/types";
import { claudeConfigDirs } from "./agent-store-roots";

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

/**
 * The store dirs for one worktree, across every config dir the agent may own.
 * The single place this module resolves a store, so an account dir can never be
 * missed by one of the two entry points below.
 *
 * Claude is the only agent with a filename-keyed store today, so the config dirs
 * are Claude's. A second such agent brings its own resolver here.
 */
function storeFor(
	agentCmd: string,
	worktreePath: string,
	home: string,
	family?: AgentFamily,
): { dirs: string[]; ext: string } | null {
	return getAgentAdapter(agentCmd, family).transcriptStore?.(worktreePath, claudeConfigDirs(home)) ?? null;
}

/** Session ids that have a transcript for this worktree, newest first. */
export function listResumableSessionIds(
	agentCmd: string,
	worktreePath: string,
	home: string = resolveUserHome(),
	family?: AgentFamily,
): string[] {
	const store = storeFor(agentCmd, worktreePath, home, family);
	if (!store) return [];
	return sessionIdsNewestFirst(store.dirs, store.ext);
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
): ResumeTarget {
	const stored = storedSessionId ?? null;
	const store = storeFor(agentCmd, worktreePath, home, family);
	if (!store || !store.dirs.some((dir) => existsSync(dir))) return { sessionId: stored, substituted: false };
	if (!stored) return { sessionId: null, substituted: false };

	const ids = sessionIdsNewestFirst(store.dirs, store.ext);
	if (ids.includes(stored)) return { sessionId: stored, substituted: false };
	return { sessionId: ids[0] ?? null, substituted: true };
}

/** Session ids across all store dirs, newest transcript first. */
function sessionIdsNewestFirst(dirs: readonly string[], ext: string): string[] {
	const found: { id: string; mtimeMs: number }[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir).filter((f) => f.endsWith(ext) && f.length > ext.length);
		} catch {
			continue;
		}
		for (const name of names) {
			found.push({ id: name.slice(0, -ext.length), mtimeMs: mtimeMsOf(`${dir}/${name}`) });
		}
	}
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.id);
}

function mtimeMsOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
