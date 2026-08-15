/**
 * Trust registrations dev3 writes into agent CLI config files outside
 * `~/.dev3.0/`, and the pruning that keeps them from growing forever.
 *
 * Every task launch registers its worktree as trusted so the agent skips its
 * "do you trust this folder?" dialog. Worktrees are disposable; without a
 * matching removal the file accumulates one dead entry per task, permanently.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveUserHome } from "../shared/user-home";
import { isDev3TrustPath, pruneCodexTrustEntries } from "./codex-config";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("worktree-trust");

const USER_HOME = resolveUserHome();

/** `~/.gemini/trustedFolders.json` — flat map of absolute path → trust verdict. */
export const GEMINI_TRUSTED_FOLDERS = `${USER_HOME}/.gemini/trustedFolders.json`;

const WORKTREES_ROOT = `${DEV3_HOME}/worktrees`;

/** Case- and separator-insensitive: keys were written by other OS installs too. */
function normalize(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isUnderWorktreesRoot(path: string): boolean {
	return normalize(path).startsWith(`${normalize(WORKTREES_ROOT)}/`);
}

/**
 * Resolve symlinks the way `ensureGeminiTrust` did when it wrote the key, but
 * survive the directory already being gone: only the parent is resolved.
 */
async function resolvedVariants(dirPath: string): Promise<string[]> {
	const variants = new Set([dirPath]);
	try {
		variants.add(await realpath(dirPath));
	} catch {
		try {
			variants.add(join(await realpath(dirname(dirPath)), basename(dirPath)));
		} catch { /* parent gone too — the raw path is all we have */ }
	}
	return [...variants];
}

/** Read the trust map, apply `mutate`, write back only if something changed. */
function updateGeminiTrustedFolders(
	mutate: (data: Record<string, string>) => string[],
): string[] {
	if (!existsSync(GEMINI_TRUSTED_FOLDERS)) return [];

	let data: Record<string, string>;
	try {
		data = JSON.parse(readFileSync(GEMINI_TRUSTED_FOLDERS, "utf-8"));
	} catch (err) {
		// Fail closed: a file we cannot parse is a file we must not rewrite.
		log.warn("Skipping ~/.gemini/trustedFolders.json prune (unparsable)", { error: String(err) });
		return [];
	}
	if (data == null || typeof data !== "object" || Array.isArray(data)) return [];

	const removed = mutate(data);
	if (removed.length === 0) return [];

	writeFileSync(GEMINI_TRUSTED_FOLDERS, JSON.stringify(data, null, 2));
	return removed;
}

/**
 * Drop every trust registration for a worktree dev3 just removed. Best-effort:
 * a failure here must never block teardown.
 *
 * This is the "forget this worktree everywhere" step — agents that gain their
 * own trust pruning belong here, next to Gemini.
 */
export async function forgetWorktreeTrust(worktreePath: string | null | undefined): Promise<void> {
	if (!worktreePath) return;
	try {
		const targets = (await resolvedVariants(worktreePath))
			.filter(isUnderWorktreesRoot)
			.map(normalize);
		if (targets.length === 0) return;

		const removed = updateGeminiTrustedFolders((data) => {
			const keys = Object.keys(data).filter((key) => targets.includes(normalize(key)));
			for (const key of keys) delete data[key];
			return keys;
		});
		if (removed.length > 0) {
			log.info("Pruned worktree from ~/.gemini/trustedFolders.json", { paths: removed });
		}

		// Codex: the entry was written as a `realpath`, and on Windows the task's own
		// path may spell its separators differently — so a dead directory counts too,
		// not just an exact match.
		const codexRemoved = pruneCodexTrustEntries(
			USER_HOME,
			(projectPath) =>
				isDev3TrustPath(projectPath, DEV3_HOME)
				&& (targets.includes(normalize(projectPath)) || !existsSync(projectPath)),
		);
		if (codexRemoved > 0) {
			log.info("Pruned worktree trust from ~/.codex/config.toml", { count: codexRemoved });
		}
	} catch (err) {
		log.warn("Failed to prune worktree trust", { error: String(err) });
	}
}

/**
 * One-time startup sweep for entries left behind by app versions that never
 * pruned. Only touches keys that are BOTH under the dev3 worktrees root AND
 * point at a directory that no longer exists — a user's own trusted folder,
 * and a live worktree, are never candidates.
 */
export function sweepStaleWorktreeTrust(): void {
	try {
		const removed = updateGeminiTrustedFolders((data) => {
			const keys = Object.keys(data).filter((key) => isUnderWorktreesRoot(key) && !existsSync(key));
			for (const key of keys) delete data[key];
			return keys;
		});
		if (removed.length > 0) {
			log.info("Swept dead worktrees from ~/.gemini/trustedFolders.json", { count: removed.length });
		}

		const codexRemoved = pruneCodexTrustEntries(
			USER_HOME,
			(projectPath) => isDev3TrustPath(projectPath, DEV3_HOME) && !existsSync(projectPath),
		);
		if (codexRemoved > 0) {
			log.info("Swept dead worktrees from ~/.codex/config.toml", { count: codexRemoved });
		}
	} catch (err) {
		log.warn("Failed to sweep stale worktree trust", { error: String(err) });
	}
}
