/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code and Codex. Extensible for Gemini, Cursor, etc.
 */

import type { PermissionMode, TaskStatus } from "../shared/types";
import { createLogger } from "./logger";
import { getAgentAdapter } from "../shared/agent-adapters/registry";
import { writeClaudeHooks, writeCodexHooks } from "../shared/agent-hooks";
import { prepareCodexWorktreeHookOverride } from "./codex-hook-trust";

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
 * Set up agent-native hooks in the worktree, driven by the agent adapter's
 * declarative hooksSpec (decision 124). The adapter decides *which* hooks (data);
 * this executor performs the I/O. Returns a Codex `-c hooks=...` config override
 * to splice into the launch command, or null when there is nothing to inject.
 */
export function setupAgentHooks(
	worktreePath: string,
	baseCommand: string,
	options?: { stopTarget?: TaskStatus; permissionMode?: PermissionMode },
): Promise<string | null> {
	const spec = getAgentAdapter(baseCommand).hooksSpec(options);
	if (!spec) return Promise.resolve(null);

	if (spec.kind === "claude") {
		writeClaudeHooks(worktreePath, { stopTarget: spec.stopTarget, permissionMode: spec.permissionMode });
		log.info("Claude hooks installed", {
			worktreePath,
			permissionMode: spec.permissionMode,
		});
		return Promise.resolve(null);
	}

	// spec.kind === "codex"
	writeCodexHooks(worktreePath);
	return prepareCodexWorktreeHookOverride(worktreePath).then((configOverride) => {
		log.info("Codex worktree hooks installed with session-scoped trust", { worktreePath });
		return configOverride;
	});
}
