// ---- System requirements ----

export interface RequirementCheckResult {
	id: string;
	name: string;
	installed: boolean;
	installHint: string; // i18n key
	/** Copy-pasteable install command; absent when the tool cannot be installed
	 *  on this platform (e.g. tmux on Windows). */
	installCommand?: string;
	resolvedPath?: string; // full path to the binary (if found)
	brewInstallable: boolean;
	customPathError?: boolean; // true if custom path was set but file doesn't exist
	optional?: boolean; // optional requirements don't block the app
}

// ---- Rosetta warning ----

/**
 * Reinstall info for an Intel (x64) build running translated under Rosetta 2
 * on an Apple Silicon Mac; null when the process is not translated. `command`
 * is a copy-pasteable terminal command to reinstall the native arm64 build;
 * `kind` says which reinstall path it uses (affects the instruction copy).
 */
export type RosettaWarningInfo = { command: string; kind: "brew" | "dmg" } | null;

// ---- Agent availability ----

export interface AgentCheckResult {
	agentId: string;
	name: string;
	baseCommand: string;
	installed: boolean;
	resolvedPath?: string;
	installCommand?: string;
	/** Another install route for this host, shown beside `installCommand`. */
	alternativeInstallCommand?: string;
	installUrl?: string;
	customPathError?: boolean;
}

/**
 * Evidence that an installed agent CLI has credentials. Three-valued on purpose:
 * `unknown` means dev3 has no probe for that CLI, and must never be treated as
 * "logged out". See `bun/harness-readiness.ts`.
 */
export type HarnessSignIn = "signed-in" | "not-signed-in" | "unknown";

export interface HarnessReadiness {
	agentId: string;
	name: string;
	baseCommand: string;
	installed: boolean;
	signIn: HarnessSignIn;
}

export interface HarnessReadinessReport {
	harnesses: HarnessReadiness[];
	/** Agent ids that are installed and not provably signed out — what the UI gates on. */
	usable: string[];
	/** No agent CLI is installed at all: a different, more basic problem. */
	noneInstalled: boolean;
}


// ---- Agent skills catalog ----

/** A skill discovered in a project-local or global agent skill directory. */
export interface AgentSkillInfo {
	/** Skill name from SKILL.md frontmatter (falls back to the directory name). */
	name: string;
	/** First-line description from SKILL.md frontmatter; empty when absent. */
	description: string;
	/** Which skill directory kind the skill was found in. */
	source: "agents" | "claude" | "codex";
}
