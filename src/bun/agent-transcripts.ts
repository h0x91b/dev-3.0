import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
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
	/** Id for `--resume`, or null when there is nothing of this pane's to reopen. */
	sessionId: string | null;
	/** The stored id had no transcript of its own, so this replaces it (worth logging). */
	substituted: boolean;
	/** The store was checked and nothing is left for this pane: every transcript
	 *  belongs to another pane, so the agent's own "latest" would duplicate one. */
	startFresh: boolean;
	/** A transcript for `sessionId` was actually found on disk. False when the store could not be read. */
	verified: boolean;
}

/** What the resolver needs of one stored pane. */
export interface ResumeCandidate {
	agentCmd: string;
	sessionId: string | null;
	agentFamily?: AgentFamily | null;
	/** The directory whose store holds this pane's conversation, when it is not
	 *  the task's own. Checked before healing. */
	sessionOriginCwd?: string | null;
	/** May take over the newest unclaimed transcript when its own is gone. Only the
	 *  main pane: an extra pane with no conversation of its own was, now that hooks
	 *  keep the ids current, almost always never prompted, so it starts fresh. */
	adoptsOrphan?: boolean;
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
 * Pick the session id to resume for every pane of one task, from ONE snapshot of
 * the store, so no two panes are handed the same conversation.
 *
 * A pane keeps its stored id when that id has a transcript and no earlier pane
 * claimed it. A pane that `adoptsOrphan` otherwise gets the newest transcript
 * nobody claimed; every other pane gets `startFresh`. Healing each pane on its
 * own gave every stale pane the same newest transcript (h0x91b/dev-3.0#1950). A
 * pane whose store cannot be checked passes its stored id through untouched.
 */
export function resolveResumableSessionIds(
	worktreePath: string,
	panes: readonly ResumeCandidate[],
	home: string = resolveUserHome(),
): ResumeTarget[] {
	const targets: ResumeTarget[] = new Array(panes.length);
	const claimed = new Set<string>();
	const snapshots = new Map<string, string[]>();
	const unresolved: { index: number; ids: string[] }[] = [];

	panes.forEach((pane, index) => {
		const stored = pane.sessionId ?? null;
		const store = storeFor(pane.agentCmd, worktreePath, home, pane.agentFamily ?? undefined);
		if (!store || !store.dirs.some((dir) => existsSync(dir))) {
			targets[index] = { sessionId: stored, substituted: false, startFresh: false, verified: false };
			return;
		}
		const key = [store.ext, ...store.dirs].join("\0");
		let ids = snapshots.get(key);
		if (!ids) {
			ids = sessionIdsNewestFirst(store.dirs, store.ext);
			snapshots.set(key, ids);
		}
		if (stored && !claimed.has(stored) && (ids.includes(stored) || inOriginStore(pane, stored, home) || inSiblingStore(store, stored))) {
			claimed.add(stored);
			targets[index] = { sessionId: stored, substituted: false, startFresh: false, verified: true };
			return;
		}
		unresolved.push({ index, ids });
	});

	for (const { index, ids } of unresolved) {
		const next = panes[index].adoptsOrphan ? ids.find((id) => !claimed.has(id)) ?? null : null;
		if (next) claimed.add(next);
		// An adopted id is dev3's guess even when nothing was stored, so it reports as
		// substituted. A main pane facing an empty store has nobody to collide with and
		// keeps the agent's own latest.
		const startFresh = next === null && (ids.length > 0 || !panes[index].adoptsOrphan);
		targets[index] = { sessionId: next, substituted: next !== null || panes[index].sessionId != null, startFresh, verified: next !== null };
	}
	return targets;
}

/**
 * A conversation that began elsewhere never migrates into this worktree's store:
 * a resume appends to the original file and only stamps the new cwd into the new
 * records. The agent DOES create the worktree's store directory though — empty,
 * holding just `memory/` — so without this look the pane would be healed away
 * from a live id.
 */
function inOriginStore(pane: ResumeCandidate, stored: string, home: string): boolean {
	if (!pane.sessionOriginCwd) return false;
	const origin = storeFor(pane.agentCmd, pane.sessionOriginCwd, home, pane.agentFamily ?? undefined);
	return !!origin && sessionIdsNewestFirst(origin.dirs, origin.ext).includes(stored);
}

/**
 * An in-session `/resume` can switch a pane to a conversation that lives in
 * another directory's store, and nothing records which one. Every store sits
 * beside the worktree's own, so look for that exact id there.
 */
function inSiblingStore(store: { dirs: string[]; ext: string }, stored: string): boolean {
	if (basename(stored) !== stored || stored.startsWith(".")) return false;
	for (const projectsDir of new Set(store.dirs.map((dir) => dirname(dir)))) {
		let entries: string[];
		try {
			entries = readdirSync(projectsDir);
		} catch {
			continue;
		}
		if (entries.some((entry) => existsSync(`${projectsDir}/${entry}/${stored}${store.ext}`))) return true;
	}
	return false;
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
