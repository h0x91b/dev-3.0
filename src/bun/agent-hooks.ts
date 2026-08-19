/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code and Codex. Extensible for Gemini, Cursor, etc.
 */

import type { AgentFamily, PermissionMode, TaskStatus } from "../shared/types";
import { createLogger } from "./logger";
import { getAgentAdapter } from "../shared/agent-adapters/registry";
import { writeClaudeHooks, writeCodexHooks } from "../shared/agent-hooks";
import { CODEX_HOOK_TRUST_BYPASS_FLAG, detectCodexHookTrustBypass } from "./codex-config";

export {
	buildClaudeHooks,
	buildCodexHooks,
	mergeClaudeHooks,
	mergeCodexHooks,
	writeClaudeHooks,
	writeCodexHooks,
} from "../shared/agent-hooks";

const log = createLogger("agent-hooks");

/** `codex --help` is a synchronous child spawn, and this runs on every launch. */
let cachedHookTrustBypass: boolean | undefined;
function getCodexHookTrustBypassCached(): boolean {
	if (cachedHookTrustBypass === undefined) cachedHookTrustBypass = detectCodexHookTrustBypass();
	return cachedHookTrustBypass;
}

/** Reset the cached probe. Exposed for test isolation. */
export function __resetCodexHookTrustBypassCache(): void {
	cachedHookTrustBypass = undefined;
}

/**
 * Set up agent-native hooks in the worktree, driven by the agent adapter's
 * declarative hooksSpec (decision 124). The adapter decides *which* hooks (data);
 * this executor performs the I/O. Returns an extra launch flag to splice into the
 * command, or null when there is nothing to add.
 *
 * `options.family` is which CLI this command actually is, which beats the
 * command-name guess — without it a wrapper script silently got no hooks.
 */
export function setupAgentHooks(
	worktreePath: string,
	baseCommand: string,
	options?: {
		stopTarget?: TaskStatus;
		permissionMode?: PermissionMode;
		family?: AgentFamily;
	},
): Promise<string | null> {
	const spec = getAgentAdapter(baseCommand, options?.family).hooksSpec(options);
	if (!spec) {
		// The one silent failure class worth a log line: no hooks means the task
		// never moves between columns on its own, and nothing else says so.
		log.info("No agent-native hooks for this command", {
			worktreePath,
			baseCommand,
			family: options?.family ?? "auto",
		});
		return Promise.resolve(null);
	}

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
	if (!getCodexHookTrustBypassCached()) {
		// Worth a line: the definitions are in place, Codex reports them untrusted,
		// and an untrusted hook is skipped in silence — so the board simply stops
		// following this task and nothing else would say why.
		log.warn("Codex cannot bypass hook trust; status hooks will not fire", { worktreePath });
		return Promise.resolve(null);
	}
	log.info("Codex status hooks active (declared in config.toml)", { worktreePath });
	return Promise.resolve(CODEX_HOOK_TRUST_BYPASS_FLAG);
}
