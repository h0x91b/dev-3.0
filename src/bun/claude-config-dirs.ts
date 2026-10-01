/**
 * Claude config dirs that a launch pinned through `CLAUDE_CONFIG_DIR` (project
 * env, agent config env, or the server's own env). dev3 writes worktree trust into
 * each one's `.claude.json`, so the trust pruner has to know where they are -
 * nothing else on disk records a project-env value outside the project itself.
 * Managed account dirs are not recorded here; the account registry already lists them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("claude-config-dirs");

export const CLAUDE_CONFIG_DIRS_FILE = join(DEV3_HOME, "claude-config-dirs.json");

export function listPinnedClaudeConfigDirs(file: string = CLAUDE_CONFIG_DIRS_FILE): string[] {
	try {
		if (!existsSync(file)) return [];
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as { dirs?: unknown };
		return Array.isArray(parsed.dirs) ? parsed.dirs.filter((d): d is string => typeof d === "string") : [];
	} catch {
		return [];
	}
}

/** Record a pinned dir (idempotent). Non-fatal: a failure only costs pruning. */
export function rememberPinnedClaudeConfigDir(dir: string, file: string = CLAUDE_CONFIG_DIRS_FILE): void {
	const known = listPinnedClaudeConfigDirs(file);
	if (known.includes(dir)) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ dirs: [...known, dir] }, null, 2)}\n`, "utf-8");
	} catch (err) {
		log.warn("Failed to record pinned Claude config dir (non-fatal)", { dir, error: String(err) });
	}
}
