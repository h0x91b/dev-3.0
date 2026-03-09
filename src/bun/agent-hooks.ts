/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code.  Extensible for Gemini, Cursor, etc.
 */

import { createLogger } from "./logger";
import { isClaudeCommand } from "./agents";
import { writeClaudeHooks } from "../shared/agent-hooks";

export { buildClaudeHooks, mergeClaudeHooks, writeClaudeHooks } from "../shared/agent-hooks";

const log = createLogger("agent-hooks");

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
		writeClaudeHooks(worktreePath, taskId);
		log.info("Claude hooks installed", {
			worktreePath,
			taskId: taskId.slice(0, 8),
		});
		return;
	}
	// Future: isGeminiCommand, isCursorCommand, etc.
}
