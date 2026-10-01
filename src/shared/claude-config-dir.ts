/**
 * Where Claude Code keeps its user-level config for one launch. Claude Code reads
 * `CLAUDE_CONFIG_DIR` when set - settings.json, skills/ and its own .claude.json
 * all live inside it - and falls back to ~/.claude plus ~/.claude.json otherwise.
 * Anything dev3 writes for Claude must follow the same rule, or it lands in a
 * directory the agent never reads (`decisions/2026/10/01/claude-config-dir-everywhere.md`).
 */
import { join } from "node:path";

export interface ClaudeConfigLocation {
	/** The user-level config dir: skills/, settings.json, output-styles/. */
	dir: string;
	/** Claude Code's global state file (trust, per-project MCP state). */
	claudeJson: string;
	/** True when `CLAUDE_CONFIG_DIR` chose the dir, false for the ~/.claude default. */
	pinned: boolean;
}

/** `~` expanded and trailing slashes dropped, so one dir has one spelling (registry, prune). */
function normalizeDir(raw: string | undefined, home: string): string | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const expanded = trimmed === "~" || trimmed.startsWith("~/") ? home + trimmed.slice(1) : trimmed;
	return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

/** Resolve the config location from the env the agent will actually see. */
export function claudeConfigLocation(env: Record<string, string | undefined>, home: string): ClaudeConfigLocation {
	const pinnedDir = normalizeDir(env.CLAUDE_CONFIG_DIR, home);
	if (pinnedDir) return { dir: pinnedDir, claudeJson: join(pinnedDir, ".claude.json"), pinned: true };
	return { dir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), pinned: false };
}

/**
 * The env a launched agent ends up with for config-dir purposes: the launch's own
 * env wins, the server's inherited env fills in, exactly as the launch script
 * exports over the inherited environment.
 */
export function launchClaudeConfigLocation(
	launchEnv: Record<string, string | undefined> | undefined,
	processEnv: Record<string, string | undefined>,
	home: string,
): ClaudeConfigLocation {
	const fromLaunch = launchEnv?.CLAUDE_CONFIG_DIR?.trim();
	return claudeConfigLocation({ CLAUDE_CONFIG_DIR: fromLaunch || processEnv.CLAUDE_CONFIG_DIR }, home);
}
