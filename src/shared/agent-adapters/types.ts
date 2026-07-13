/**
 * AgentAdapter — the single seam for every per-agent launch/trust/hooks/skill
 * difference (decision 124). One implementation per coding agent, plus an
 * explicit GenericAdapter fallback for unknown/custom commands.
 *
 * Adapters are PURE descriptors: their members return *data* (arg tokens, trust
 * kinds, hook specs, capability flags) and never touch fs/spawn. A thin executor
 * in src/bun applies that data to disk. This mirrors the existing
 * build*Hooks (pure) / write*Hooks (I/O) split and keeps the core in src/shared
 * (which must not import src/bun), so each adapter is unit-testable without a PTY.
 */

import type { AgentConfiguration, PermissionMode, TaskStatus } from "../types";
import type { TemplateContext } from "./template";

export type { TemplateContext } from "./template";

/** Agent-native trust routine a launch needs, in apply order (executor maps each
 *  to its ensure* function). Current dev3 applies Claude trust to *every* agent
 *  (harmless superset + MCP pre-approval), so most adapters include "claude". */
export type TrustKind = "claude" | "codex" | "gemini";

/** Declarative description of the agent-native lifecycle hooks to install. The
 *  backend executor dispatches on `kind`; the hook *content* is the pure
 *  build*Hooks data in src/shared/agent-hooks.ts. */
export type HooksSpec =
	| { kind: "claude"; stopTarget?: TaskStatus; permissionMode?: PermissionMode }
	| { kind: "codex" };

/** Codex-only launch runtime resolved by the backend (theme state + a
 *  `codex --help` probe are impure) and threaded into the pure CodexAdapter. */
export interface CodexLaunchRuntime {
	/** Themed profile name substituted for a bare `dev3` profile (e.g. "dev3-dark"). */
	themedProfile: string;
	/** tui.theme value appended as a `-c` override (e.g. "dracula"). */
	theme: string;
	/** Flag the installed codex accepts to select a profile file (see issue #611). */
	profileLaunchFlag: "--profile" | "--profile-v2";
}

/** Pure inputs to `launchArgs`. The backend maps its public CommandOptions
 *  (plus the resolved provider / codex runtime) into this shape. */
export interface AdapterLaunchOptions {
	/** Resume the previous session instead of starting fresh (ignored if the
	 *  adapter does not support resume). */
	resume?: boolean;
	/** Session id to resume or pre-assign. */
	sessionId?: string;
	/** Skip out-of-band dev3 protocol injection (Claude --append-system-prompt,
	 *  Codex -c developer_instructions). */
	skipSystemPrompt?: boolean;
	/** statusLine-wrapper settings file (Claude only). */
	statuslineSettingsFile?: string;
	/** True when a third-party backend (e.g. Bedrock) is active → omit --model. */
	skipModelForProvider?: boolean;
	/** Codex-only runtime (theme/profile/launch-flag); present only for codex. */
	codex?: CodexLaunchRuntime;
}

export interface AgentAdapter {
	/** Registry key: the base command's last path segment (e.g. "claude"). */
	readonly command: string;
	/** Whether the CLI supports session resumption. */
	readonly supportsResume: boolean;
	/** Whether the CLI accepts a pre-assigned session id on a fresh launch. */
	readonly supportsPreAssignedSessionId: boolean;
	/** The dev3 skill / system-prompt body this agent delivers (data). */
	readonly skillBody: string;
	/** Agent-native trust routines to run, in order. Empty when none. */
	readonly trustKinds: readonly TrustKind[];

	/**
	 * The complete launch command as a token list (base command first), which the
	 * caller joins with " ". Each adapter owns its whole arg order — there is no
	 * shared flag sequence. Pure: no fs/spawn, no reads of ambient state.
	 */
	launchArgs(
		baseCmd: string,
		config: AgentConfiguration | undefined,
		ctx: TemplateContext,
		options?: AdapterLaunchOptions,
	): string[];

	/**
	 * Minimal resume command for tmux-death / restart recovery (no prompt, no
	 * system prompt), or null when the agent cannot resume.
	 */
	buildResumeCommand(baseCmd: string, sessionId?: string): string | null;

	/** Agent-native lifecycle hooks to install, or null when the agent has none. */
	hooksSpec(options?: { stopTarget?: TaskStatus; permissionMode?: PermissionMode }): HooksSpec | null;
}
