/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code.  Extensible for Gemini, Cursor, etc.
 */

import type { TaskStatus } from "../shared/types";
import { createLogger } from "./logger";
import { isClaudeCommand, isCodexCommand } from "./agents";
import { writeClaudeHooks, writeCodexHooks } from "../shared/agent-hooks";

export {
	buildClaudeHooks,
	buildCodexHooks,
	mergeClaudeHooks,
	mergeCodexHooks,
	writeClaudeHooks,
	writeCodexHooks,
} from "../shared/agent-hooks";

const log = createLogger("agent-hooks");

/**
 * Set up agent-native hooks in the worktree.
 * Routes to the appropriate setup function based on agent type.
 */
export function setupAgentHooks(
	worktreePath: string,
	baseCommand: string,
	options?: { stopTarget?: TaskStatus },
): void {
	if (isClaudeCommand(baseCommand)) {
		writeClaudeHooks(worktreePath, options);
		log.info("Claude hooks installed", {
			worktreePath,
		});
		return;
	}
	if (isCodexCommand(baseCommand)) {
		writeCodexHooks(worktreePath, options);
		log.info("Codex hooks installed", {
			worktreePath,
		});
		return;
	}
	// Future: isGeminiCommand, isCursorCommand, etc.
}
