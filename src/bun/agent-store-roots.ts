import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";

/**
 * Where an agent CLI keeps its state on this machine — the home store PLUS every
 * dev3 agent account.
 *
 * dev3 injects `CLAUDE_CONFIG_DIR=~/.dev3.0/agent-accounts/claude/<id>` (and
 * `CODEX_HOME` for Codex) into the sessions it launches, so an account directory
 * IS that session's config directory: its transcripts land there and a scan of
 * the home store alone cannot see them. Every discovery path must resolve its
 * roots here, or half a machine's history is invisible.
 *
 * Missing directories are normal — a machine has whichever accounts it has.
 */

/** Enumerate `~/.dev3.0/agent-accounts/<kind>/*`, newest-agnostic, existing only. */
function accountDirs(home: string, kind: string): string[] {
	const parent = `${home}/.dev3.0/agent-accounts/${kind}`;
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
	}
	return entries.map((entry) => `${parent}/${entry}`).filter((dir) => existsSync(dir));
}

/**
 * Claude config dirs: `~/.claude` first, then each agent account.
 *
 * An account whose directory is a symlink onto the home store is skipped — dev3
 * creates that shape for the "use my own login" account, and following it would
 * report every home transcript a second time.
 */
export function claudeConfigDirs(home: string): string[] {
	const homeStore = `${home}/.claude`;
	const dirs = [homeStore];
	const homeReal = realpathOf(homeStore);
	for (const dir of accountDirs(home, "claude")) {
		if (isSymlink(dir) && homeReal && realpathOf(dir) === homeReal) continue;
		dirs.push(dir);
	}
	return dirs;
}

/** Codex rollout stores: `~/.codex/sessions` plus each agent account's. */
export function codexSessionRoots(home: string): string[] {
	const roots = [`${home}/.codex/sessions`, ...accountDirs(home, "codex").map((dir) => `${dir}/sessions`)];
	return roots.filter((root) => existsSync(root));
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function realpathOf(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}
