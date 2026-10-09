/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code, Codex and omp. Extensible for Gemini, Cursor, etc.
 */

import type { AgentFamily, PermissionMode, TaskStatus } from "../shared/types";
import { createLogger } from "./logger";
import { getAgentAdapter } from "../shared/agent-adapters/registry";
import {
	isDev3OwnedFolder,
	writeClaudeFlagSettings,
	writeClaudeHooks,
	writeCodexHooks,
	writeCopilotHooks,
} from "../shared/agent-hooks";
import { quoteIfUnsafe } from "../shared/agent-adapters/shell";
import { writeOmpStatusExtension } from "../shared/omp-status-extension";
import { resolveCopilotHome } from "./copilot-config";
import { CODEX_HOOK_TRUST_BYPASS_FLAG, detectCodexHookTrustBypass, resetCodexHelpProbe } from "./codex-config";

export {
	buildClaudeHooks,
	buildCodexHooks,
	buildCopilotHooks,
	mergeClaudeHooks,
	mergeCodexHooks,
	writeClaudeHooks,
	writeCodexHooks,
	writeCopilotHooks,
} from "../shared/agent-hooks";

const log = createLogger("agent-hooks");

/** Concurrent launches share the same asynchronous capability probe. */
let cachedHookTrustBypass: Promise<boolean> | undefined;
function getCodexHookTrustBypassCached(): Promise<boolean> {
	if (cachedHookTrustBypass === undefined) cachedHookTrustBypass = detectCodexHookTrustBypass();
	return cachedHookTrustBypass;
}

/** Reset the cached probe. Exposed for test isolation. */
export function __resetCodexHookTrustBypassCache(): void {
	cachedHookTrustBypass = undefined;
	resetCodexHelpProbe();
}

/**
 * What a launch command needs after hook setup: `flag` is spliced in after the
 * binary; `claudeSettingsFile` replaces the `--settings` file the command already
 * passes. Null when the command stays as it is.
 */
export interface AgentHookLaunch {
	flag?: string;
	claudeSettingsFile?: string;
}

/**
 * Set up agent-native hooks in the worktree, driven by the agent adapter's
 * declarative hooksSpec (decision 124). The adapter decides *which* hooks (data);
 * this executor performs the I/O.
 *
 * In a folder dev3 does not own (a project with its git workflow off), Claude's
 * hooks travel in a `--settings` file built from `options.claudeSettingsFile`,
 * the managed file the command passes, so nothing is written into the folder.
 * Codex's hooks already come from `config.toml`, so its folder file is skipped.
 *
 * `options.family` is which CLI this command actually is, which beats the
 * command-name guess - without it a wrapper script silently got no hooks.
 */
export async function setupAgentHooks(
	worktreePath: string,
	baseCommand: string,
	options?: {
		stopTarget?: TaskStatus;
		permissionMode?: PermissionMode;
		family?: AgentFamily;
		claudeSettingsFile?: string;
	},
): Promise<AgentHookLaunch | null> {
	const spec = getAgentAdapter(baseCommand, options?.family).hooksSpec(options);
	if (!spec) {
		// The one silent failure class worth a log line: no hooks means the task
		// never moves between columns on its own, and nothing else says so.
		log.info("No agent-native hooks for this command", {
			worktreePath,
			baseCommand,
			family: options?.family ?? "auto",
		});
		return null;
	}

	if (spec.kind === "claude") {
		if (options?.claudeSettingsFile && !isDev3OwnedFolder(worktreePath)) {
			const claudeSettingsFile = writeClaudeFlagSettings(options.claudeSettingsFile, {
				stopTarget: spec.stopTarget,
				permissionMode: spec.permissionMode,
			});
			log.info("Claude hooks passed with --settings; nothing written to the folder", { worktreePath, claudeSettingsFile });
			return { claudeSettingsFile };
		}
		const { skippedSymlink } = writeClaudeHooks(worktreePath, {
			stopTarget: spec.stopTarget,
			permissionMode: spec.permissionMode,
		});
		if (skippedSymlink) {
			// The board stops following this task, so say why.
			log.warn("Claude hooks not written: settings path is a symlink", { worktreePath, symlink: skippedSymlink });
			return null;
		}
		log.info("Claude hooks installed", {
			worktreePath,
			permissionMode: spec.permissionMode,
		});
		return null;
	}

	if (spec.kind === "copilot") {
		// Copilot's hooks are user-level, not worktree-level (see writeCopilotHooks);
		// the DEV3_TASK_ID guard in each command is what keeps them inert elsewhere.
		const copilotHome = resolveCopilotHome();
		try {
			writeCopilotHooks(copilotHome);
			log.info("Copilot status hooks installed", { copilotHome });
		} catch (err) {
			// Same silent-failure class as a missing hooksSpec: without these the
			// task never leaves its column and nothing else would say why.
			log.warn("Could not write Copilot hooks", { copilotHome, error: String(err) });
		}
		return null;
	}
	if (spec.kind === "omp") {
		// One generated module under the dev3 home, loaded by absolute path. omp
		// applies no trust gate to an explicitly passed `--hook`, so unlike Codex
		// there is no bypass to probe for; a failed write throws to the caller,
		// which launches without the flag and logs it.
		const path = writeOmpStatusExtension();
		log.info("omp status extension active", { worktreePath, path });
		return { flag: `--hook ${quoteIfUnsafe(path)}` };
	}

	// spec.kind === "codex". The live hooks come from config.toml; in a folder dev3
	// does not own this file would only outlive the task as unguarded project hooks.
	const codexSymlink = isDev3OwnedFolder(worktreePath) ? writeCodexHooks(worktreePath) : null;
	if (codexSymlink) {
		// No trust bypass either: whatever hooks sit behind the link are not dev3's.
		log.warn("Codex hooks not written: hooks path is a symlink", { worktreePath, symlink: codexSymlink });
		return null;
	}
	if (!(await getCodexHookTrustBypassCached())) {
		// Worth a line: the definitions are in place, Codex reports them untrusted,
		// and an untrusted hook is skipped in silence — so the board simply stops
		// following this task and nothing else would say why.
		log.warn("Codex cannot bypass hook trust; status hooks will not fire", { worktreePath });
		return null;
	}
	log.info("Codex hook files prepared; a fresh Codex process is required to load changes", { worktreePath });
	return { flag: CODEX_HOOK_TRUST_BYPASS_FLAG };
}
