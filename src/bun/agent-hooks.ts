/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code.  Extensible for Gemini, Cursor, etc.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";
import { isClaudeCommand } from "./agents";
import { mergeClaudeHooks } from "../shared/agent-hooks";

export { buildClaudeHooks, mergeClaudeHooks } from "../shared/agent-hooks";

const log = createLogger("agent-hooks");

/**
 * Write .claude/settings.local.json in the worktree with dev3 hooks.
 */
export function setupClaudeHooks(
	worktreePath: string,
	taskId: string,
): void {
	const claudeDir = join(worktreePath, ".claude");
	const settingsPath = join(claudeDir, "settings.local.json");

	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(settingsPath)) {
			existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// Corrupted file — overwrite
	}

	const updated = mergeClaudeHooks(existing, taskId);

	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(
		settingsPath,
		JSON.stringify(updated, null, 2) + "\n",
		"utf-8",
	);
	log.info("Claude hooks installed", {
		worktreePath,
		taskId: taskId.slice(0, 8),
	});
}

// ---- Dispatcher ----

/**
 * Set up agent-native hooks in the worktree.
 * Routes to the appropriate setup function based on agent type.
 */
export function setupAgentHooks(
	worktreePath: string,
	taskId: string,
	baseCommand: string,
): void {
	if (isClaudeCommand(baseCommand)) {
		setupClaudeHooks(worktreePath, taskId);
		return;
	}
	// Future: isGeminiCommand, isCursorCommand, etc.
}
