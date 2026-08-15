/**
 * Claude Code's half of the worktree-trust pruning in `worktree-trust.ts` —
 * `~/.claude.json`, plus the same file inside every managed Claude account dir.
 *
 * `ensureClaudeTrust` writes a `projects["<worktree path>"]` entry per task launch
 * so Claude Code skips its trust dialog. Nothing removed them: on one machine
 * 2 130 of 2 771 entries pointed at deleted worktrees — 48% of a 1.9 MB file that
 * Claude Code parses and rewrites continuously.
 *
 * This file belongs to Claude Code and to the user, so the rules are stricter than
 * for a file of ours: unknown keys survive, an unparsable file is never rewritten,
 * and a concurrent Claude Code write always wins
 * (`decisions/2026/08/15/prune-claude-json-trust-entries.md`).
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { resolveUserHome } from "../shared/user-home";
import { listClaudeAccountDirs } from "./agent-accounts";
import { createLogger } from "./logger";

const log = createLogger("claude-json-prune");

/** Why a file was left alone. `null` means it was swept (possibly removing 0 entries). */
export type PruneSkipReason = "absent" | "unreadable" | "unparsable" | "busy";

export interface PruneFileResult {
	file: string;
	removed: number;
	skipped: PruneSkipReason | null;
}

export interface PruneOptions {
	/** `.claude.json` files to sweep. Defaults to ~/.claude.json + every managed account's. */
	files?: string[];
	/** Directory-existence probe (injected in tests). */
	exists?: (path: string) => boolean;
}

/** How many times a concurrent Claude Code rewrite may push us into a re-read. */
const MAX_ATTEMPTS = 3;

/** Picks which `projects` keys to delete, out of the file's current key list. */
type SelectDeadKeys = (keys: string[]) => string[];

function defaultFiles(): string[] {
	return [join(resolveUserHome(), ".claude.json"), ...listClaudeAccountDirs().map((dir) => join(dir, ".claude.json"))];
}

/**
 * Apply `select` to one `.claude.json`'s `projects` map and write the result back.
 * Never throws: every failure mode leaves the file exactly as it was.
 */
function updateClaudeJson(file: string, select: SelectDeadKeys): PruneFileResult {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let before!: Stats;
		let raw: string;
		try {
			if (!existsSync(file)) return { file, removed: 0, skipped: "absent" };
			before = statSync(file);
			raw = readFileSync(file, "utf-8");
		} catch (err) {
			log.warn("Cannot read .claude.json, leaving it alone", { file, error: String(err) });
			return { file, removed: 0, skipped: "unreadable" };
		}

		let data: any;
		try {
			data = JSON.parse(raw);
		} catch (err) {
			// Fail closed: a file we cannot parse is a file we must not rewrite.
			log.warn("Unparsable .claude.json, leaving it alone", { file, error: String(err) });
			return { file, removed: 0, skipped: "unparsable" };
		}

		const projects = data?.projects;
		if (!projects || typeof projects !== "object") return { file, removed: 0, skipped: null };

		const dead = select(Object.keys(projects));
		if (dead.length === 0) return { file, removed: 0, skipped: null };
		for (const key of dead) delete projects[key];

		if (writeVerified(file, JSON.stringify(data, null, 2), before)) {
			log.info("Pruned dev3 trust entries from .claude.json", { file, removed: dead.length, attempt });
			return { file, removed: dead.length, skipped: null };
		}
		log.info("Claude Code rewrote .claude.json mid-prune, retrying", { file, attempt });
	}

	log.warn("Gave up pruning .claude.json — file kept changing under us", { file });
	return { file, removed: 0, skipped: "busy" };
}

/**
 * Atomically replace `file` with `content`, but only if it has not changed since
 * `before` was taken. Claude Code rewrites this file continuously; a blind rename
 * would silently drop whatever it wrote while we were parsing.
 */
function writeVerified(file: string, content: string, before: Stats): boolean {
	const tmp = `${file}.dev3-prune.tmp`;
	try {
		writeFileSync(tmp, content, { mode: before.mode & 0o777 });
	} catch (err) {
		log.warn("Failed to stage pruned .claude.json", { file, error: String(err) });
		return false;
	}
	try {
		const now = statSync(file);
		if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
			unlinkSync(tmp);
			return false;
		}
		renameSync(tmp, file);
		return true;
	} catch (err) {
		log.warn("Failed to replace .claude.json", { file, error: String(err) });
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort
		}
		return false;
	}
}

function sweep(select: SelectDeadKeys, opts: PruneOptions): PruneFileResult[] {
	const files = opts.files ?? defaultFiles();
	return files.map((file) => {
		try {
			return updateClaudeJson(file, select);
		} catch (err) {
			// Defensive: updateClaudeJson already swallows everything it can.
			log.warn("Prune failed", { file, error: String(err) });
			return { file, removed: 0, skipped: "unreadable" as const };
		}
	});
}

/**
 * Drop the trust entries for one worktree dev3 just removed. `normalizedTargets`
 * are the caller's normalized path variants and `normalize` is the function that
 * produced them (both owned by `worktree-trust.ts`). Existence is not consulted —
 * the directory is already gone by design.
 */
export function forgetClaudeTrustEntries(
	normalizedTargets: readonly string[],
	normalize: (path: string) => string,
	opts: PruneOptions = {},
): PruneFileResult[] {
	if (normalizedTargets.length === 0) return [];
	return sweep((keys) => keys.filter((key) => normalizedTargets.includes(normalize(key))), opts);
}

/**
 * Sweep entries left by app versions that never pruned. A key goes only when it is
 * BOTH inside a dev3-managed root AND points at a directory that no longer exists
 * — the user's own projects, and live worktrees, are never candidates.
 *
 * Cheap enough to run on every launch: median 8.6 ms on a real 1.9 MB file holding
 * 2 771 entries, which is why there is no one-shot migration flag.
 */
export function sweepStaleClaudeTrustEntries(
	isDev3ManagedPath: (path: string) => boolean,
	opts: PruneOptions = {},
): PruneFileResult[] {
	const exists = opts.exists ?? existsSync;
	return sweep((keys) => keys.filter((key) => isDev3ManagedPath(key) && !exists(key)), opts);
}
