import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentConfiguration, CodingAgent, LlmProvider, Project } from "../shared/types";
import { DEFAULT_AGENTS } from "../shared/types";
export { skillInvocationPrefix } from "../shared/types";
import { buildProviderEnv, getProviderDefinition, providerOmitsModelFlag, providerPinnedModel } from "../shared/llm-provider";
import { createLogger } from "./logger";
import { detectCodexProfileLaunchFlag, detectCodexVersion, ensureCodexConfig, type CodexProfileLaunchFlag } from "./codex-config";
import { DEV3_HOME } from "./paths";
import { loadSettings, saveSettings } from "./settings";
import { getCodexProfileForCurrentUiTheme, getCodexThemeForCurrentUiTheme } from "./theme-state";
import { ensureClaudeStatusLineSettings } from "./rate-limit-monitor";
import { getActiveClaudeConfigDir, getActiveClaudeSessionEnv, getActiveCodexSessionEnv } from "./agent-accounts";
import { ENV_UNSET } from "../shared/agent-accounts";
import { CLAUDE_SKILL_BODY, CODEX_SKILL_BODY, GENERIC_SKILL_BODY } from "./agent-skills";
import { getAgentAdapter, agentKey } from "../shared/agent-adapters/registry";
import type { AdapterLaunchOptions, CodexLaunchRuntime } from "../shared/agent-adapters/types";
import type { TemplateContext } from "../shared/agent-adapters/template";

// Re-exported for backward compat: these pure helpers now live in the shared
// adapter layer (src/shared must not import src/bun), but many callers/tests
// still import them from here.
export { shellEscape, quoteIfUnsafe } from "../shared/agent-adapters/shell";
export { interpolateTemplate } from "../shared/agent-adapters/template";
export type { TemplateContext } from "../shared/agent-adapters/template";

const log = createLogger("agents");

const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

// ---- Storage ----

/** Old default config IDs that were removed or renamed. These are filtered out
 *  during merge so they don't linger as phantom "user" configs. */
const DEPRECATED_CONFIG_IDS = new Set([
	"claude-plan-then-bypass-opus",
	"claude-plan-then-bypass-sonnet",
	"claude-approvals-opus",
	"claude-bypass-opus",
	// Removed when Opus 4.8's plain Auto/Bypass were replaced by explicit
	// Medium/X-High effort tiers, "Don't Ask" presets were dropped, the
	// generic "Sonnet" alias block was replaced by the pinned Sonnet 5
	// block, and Opus 4.7 was trimmed to a cold Auto/Bypass fallback.
	"claude-auto-opus48",
	"claude-bypass-opus48",
	"claude-dontask-opus48",
	"claude-auto-sonnet",
	"claude-bypass-sonnet",
	"claude-default-sonnet",
	"claude-plan-sonnet",
	"claude-approvals-sonnet",
	"claude-dontask-sonnet",
	"claude-dontask",
	"claude-default-opus47",
	"claude-plan-opus47",
	"claude-approvals-opus47",
	"claude-dontask-opus47",
	"claude-auto-sonnet5",
	"claude-bypass-sonnet5",
	"claude-dontask-sonnet5",
	// Removed when Fable 5's plain Auto/Bypass were replaced by explicit
	// Medium/X-High effort tiers, mirroring Opus 4.8.
	"claude-auto",
	"claude-bypass",
	// Removed when the single "Fable 5 (cost trick)" preset was split into
	// Bypass/Default effort tiers (Fable 5 does not behave under --permission-mode
	// auto, so the experiment offers Bypass + Default, each Medium/High/X-High).
	"claude-fable5-cost-trick",
	// Interim auto-mode cost-trick ids that never shipped (replaced by the explicit
	// bypass/default variants above) — filtered so any in-development build's stored
	// copy doesn't linger as a phantom user config.
	"claude-fable5-cost-trick-medium",
	"claude-fable5-cost-trick-high",
	"claude-fable5-cost-trick-xhigh",
	// Removed when the gpt-5.3-codex Codex presets were dropped: the model returns
	// HTTP 400 on ChatGPT-account auth ("not supported"), and OpenAI's new lineup
	// has no codex-specialized model to replace it. Codex now leads with the
	// gpt-5.6-sol frontier tier, keeping gpt-5.5 as a legacy tier below.
	"codex-5.3-heavy-bypass",
	"codex-5.3-heavy",
	"codex-5.3-medium-bypass",
	"codex-5.3-medium",
	// Interim GPT-5.6 Sol ids from the pre-release QA build. The complete lineup
	// uses model-qualified ids and real Codex effort names instead of "Heavy".
	"codex-5.6-heavy-bypass",
	"codex-5.6-heavy",
	"codex-5.6-medium-bypass",
	"codex-5.6-medium",
	// Superseded by the compact Bypass-first preset matrix. Keep prerelease
	// installs from retaining removed rows as if they were user-created.
	"codex-5.6-terra-xhigh",
	// Luna now starts at Medium; Low did not provide a useful trade-off.
	"codex-5.6-luna-low-bypass",
	"codex-5.6-luna-low",
]);

/** Merge stored agents with defaults. Missing defaults are added; stored versions win.
 *  Stored order is preserved (user can drag-reorder agents and configs).
 *  Newly added defaults (agents or configs) are appended at the end so they
 *  surface to the user without disturbing their chosen order. */
export function mergeWithDefaults(stored: CodingAgent[]): CodingAgent[] {
	const defAgentById = new Map(DEFAULT_AGENTS.map((a) => [a.id, a]));
	const storedAgentById = new Map(stored.map((a) => [a.id, a]));
	const result: CodingAgent[] = [];

	// 1. Walk stored agents first to preserve user-defined order.
	for (const existing of stored) {
		const def = defAgentById.get(existing.id);
		if (def) {
			result.push(mergeAgentWithDefault(existing, def));
		} else {
			// User-created agent — keep as-is.
			result.push(existing);
		}
	}

	// 2. Append default agents that aren't in stored at all (newly added defaults
	//    or first-run install).
	for (const def of DEFAULT_AGENTS) {
		if (!storedAgentById.has(def.id)) {
			result.push({ ...def });
		}
	}

	return result;
}

function mergeAgentWithDefault(
	existing: CodingAgent,
	def: CodingAgent,
): CodingAgent {
	const defConfigById = new Map(def.configurations.map((c) => [c.id, c]));
	const storedConfigById = new Map<string, AgentConfiguration>();
	for (const storedCfg of existing.configurations) {
		if (DEPRECATED_CONFIG_IDS.has(storedCfg.id)) continue;
		storedConfigById.set(storedCfg.id, storedCfg);
	}

	function mergeConfig(storedCfg: AgentConfiguration): AgentConfiguration {
		const defCfg = defConfigById.get(storedCfg.id);
		if (!defCfg) return storedCfg; // user-created config, keep as-is

		const storedVersion = storedCfg.version ?? 0;
		const defVersion = defCfg.version ?? 0;
		const presetUpdated = defVersion > storedVersion;

		const userOverrides = stripUndefined(storedCfg);
		if (presetUpdated) {
			delete userOverrides.additionalArgs;
			delete userOverrides.groupLabel;
			delete userOverrides.model;
			delete userOverrides.modeLabel;
			delete userOverrides.name;
			delete userOverrides.version;
		}

		return { ...defCfg, ...userOverrides };
	}

	// 1. Walk stored configs first to preserve user-defined order
	//    (covers default configs reordered AND user-created configs interleaved).
	const ordered: AgentConfiguration[] = [];
	for (const storedCfg of existing.configurations) {
		if (DEPRECATED_CONFIG_IDS.has(storedCfg.id)) continue;
		ordered.push(mergeConfig(storedCfg));
	}

	// 2. Append default configs that aren't in stored (newly added presets).
	for (const defCfg of def.configurations) {
		if (!storedConfigById.has(defCfg.id)) {
			ordered.push(defCfg);
		}
	}

	return {
		...existing,
		isDefault: true,
		configurations: ordered,
	};
}

/** Bumped whenever DEFAULT_AGENTS' preset *order* changes meaningfully enough
 *  to warrant a one-time resync of already-onboarded users' stored order
 *  (mergeWithDefaults otherwise preserves stored order forever). See
 *  decisions/ for the write-up. */
export const AGENTS_LAYOUT_REVISION = 10;

/** One-time reorder of each built-in agent's configurations to match the
 *  current DEFAULT_AGENTS declared order. Custom (non-default) configs are
 *  left in place, appended after the reordered built-ins, in their existing
 *  relative order. Pure function — callers decide when/whether to persist
 *  the result and bump `agentsLayoutRevision`. */
export function applyLayoutResync(agents: CodingAgent[]): CodingAgent[] {
	const defAgentById = new Map(DEFAULT_AGENTS.map((a) => [a.id, a]));
	return agents.map((agent) => {
		const def = defAgentById.get(agent.id);
		if (!def) return agent; // fully custom agent — nothing to resync against

		const defOrderIds = def.configurations.map((c) => c.id);
		const byId = new Map(agent.configurations.map((c) => [c.id, c]));
		const reordered: AgentConfiguration[] = [];
		for (const id of defOrderIds) {
			const cfg = byId.get(id);
			if (cfg) {
				reordered.push(cfg);
				byId.delete(id);
			}
		}
		// Anything left over (user-created configs) keeps its existing relative order, appended at the end.
		for (const cfg of agent.configurations) {
			if (byId.has(cfg.id)) reordered.push(cfg);
		}

		return { ...agent, configurations: reordered };
	});
}

/** Remove keys with undefined values so they don't shadow defaults in spread. */
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
	const result: any = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** Detect and migrate old flat format (kind-based agents) to new model. */
export function migrateOldFormat(data: any[]): CodingAgent[] {
	if (!Array.isArray(data) || data.length === 0) return [];

	// Check if this is the old format (has `kind` field)
	if (data[0] && "kind" in data[0]) {
		log.info("Migrating old agent format to new model");
		return data
			.filter((a: any) => a.kind === "custom")
			.map((a: any) => ({
				id: a.id,
				name: a.name,
				baseCommand: a.command || "bash",
				configurations: [{ id: `${a.id}-default`, name: "Default" }],
				defaultConfigId: `${a.id}-default`,
			}));
	}

	return data as CodingAgent[];
}

async function loadStoredAgents(): Promise<CodingAgent[]> {
	try {
		const file = Bun.file(AGENTS_FILE);
		if (!(await file.exists())) return [];
		const data = await file.json();
		return migrateOldFormat(data);
	} catch (err) {
		log.error("Failed to load agents", { error: String(err) });
		return [];
	}
}

async function saveAgents(agents: CodingAgent[]): Promise<void> {
	await Bun.write(AGENTS_FILE, JSON.stringify(agents, null, 2));
	log.info(`Saved ${agents.length} agent(s)`);
}

export async function getAllAgents(): Promise<CodingAgent[]> {
	const stored = await loadStoredAgents();
	const merged = mergeWithDefaults(stored);
	const mergedChanged = JSON.stringify(merged) !== JSON.stringify(stored);

	const settings = await loadSettings();
	if ((settings.agentsLayoutRevision ?? 0) >= AGENTS_LAYOUT_REVISION) {
		// Merge is also the migration path for removed presets and versioned
		// built-in updates. Persist it even when no layout resync is due so an
		// older parallel app instance reads the canonical current data from disk.
		if (mergedChanged) await saveAgents(merged);
		return merged;
	}

	// One-time resync: existing installs otherwise keep whatever stale order
	// their configs happened to have from whenever they first ran, forever.
	const resynced = applyLayoutResync(merged);
	await saveAgents(resynced);
	await saveSettings({ ...settings, agentsLayoutRevision: AGENTS_LAYOUT_REVISION });
	return resynced;
}

export async function saveAllAgents(agents: CodingAgent[]): Promise<void> {
	await saveAgents(agents);
}

// ---- Command Resolution ----

/**
 * System-prompt content injected via --append-system-prompt for all
 * Claude-based agents. Since the working directory is guaranteed to be inside
 * a dev-3.0 managed worktree, we inline the full skill body directly into the
 * system prompt instead of asking the agent to invoke `/dev3` first. The skill
 * file in `~/.claude/skills/dev3/SKILL.md` remains for manual `/dev3` use, but
 * is no longer required for the rules to take effect.
 */
export const DEV3_SYSTEM_PROMPT = CLAUDE_SKILL_BODY;

/**
 * Generic skill body for agents without automatic hooks (OpenCode,
 * Cursor Agent, etc.). Includes manual status-management instructions.
 */
export const DEV3_SYSTEM_PROMPT_GENERIC = GENERIC_SKILL_BODY;

/**
 * Codex skill body. Uses hook-aware status section and includes the Codex
 * shell note (`shell="/bin/bash"`, `login=false`). Delivered out-of-band as a
 * developer-role message via `-c developer_instructions=...` (additive — it
 * supplements Codex's base instructions, unlike `model_instructions_file`
 * which would REPLACE them).
 */
export const DEV3_SYSTEM_PROMPT_CODEX = CODEX_SKILL_BODY;

/** Returns true when the resolved base command is the Claude CLI.
 *  Retained for the Claude-only *feature* code that is orthogonal to the
 *  per-agent launch/trust/hooks seam (managed accounts, statusLine, provider/
 *  Bedrock, default env, MCP pre-approval). The codex/gemini/cursor/opencode
 *  predicates were removed — their logic lives in the agent adapters
 *  (src/shared/agent-adapters), selected via getAgentAdapter. */
export function isClaudeCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "claude";
}

let codexProfileLaunchFlagOverride: CodexProfileLaunchFlag | null = null;
let cachedCodexProfileLaunchFlag: CodexProfileLaunchFlag | undefined;

/**
 * Test-only override for codex profile launch-flag detection.
 * `true` forces `--profile-v2`, `false` forces `--profile`, `null` clears.
 */
export function __setCodexProfileV2Override(value: boolean | null): void {
	codexProfileLaunchFlagOverride = value === null ? null : value ? "--profile-v2" : "--profile";
	cachedCodexProfileLaunchFlag = undefined;
}

/**
 * The flag the installed Codex accepts to select a dev3 profile. `--profile-v2`
 * existed only in a short transition window before it was renamed to
 * `--profile`/`-p` (same file-based semantics); newer codex rejects it outright.
 * Feature-detected from `codex --help` and cached for the process lifetime —
 * version numbers do not map reliably to the rename. See issue #611.
 */
function getCodexProfileLaunchFlag(): CodexProfileLaunchFlag {
	if (codexProfileLaunchFlagOverride !== null) return codexProfileLaunchFlagOverride;
	if (cachedCodexProfileLaunchFlag === undefined) {
		cachedCodexProfileLaunchFlag = detectCodexProfileLaunchFlag();
	}
	return cachedCodexProfileLaunchFlag;
}

/**
 * `codex --version`, cached for the process lifetime. The probe is a
 * synchronous child spawn — uncached it ran on EVERY task launch inside
 * ensureCodexTrust, blocking the main loop each time.
 */
let cachedCodexVersion: string | null | undefined;
function getCodexVersionCached(): string | null {
	if (cachedCodexVersion === undefined) {
		cachedCodexVersion = detectCodexVersion();
	}
	return cachedCodexVersion;
}

/** Reset the cached codex version. Exposed for test isolation. */
export function __resetCodexVersionCache(): void {
	cachedCodexVersion = undefined;
}

/** Resolve the impure Codex launch runtime (active UI theme → profile/theme,
 *  and the feature-detected profile launch flag) into pure data the CodexAdapter
 *  consumes. Only called for Codex launches so non-Codex agents never trigger the
 *  `codex --help` probe. */
function codexLaunchRuntime(): CodexLaunchRuntime {
	return {
		themedProfile: getCodexProfileForCurrentUiTheme(),
		theme: getCodexThemeForCurrentUiTheme(),
		profileLaunchFlag: getCodexProfileLaunchFlag(),
	};
}

export interface CommandOptions {
	/** When true, resume the previous session instead of starting a new one.
	 *  Supported agents: Claude (--continue), Codex (resume --last),
	 *  Gemini (--resume latest), Cursor Agent (--continue). */
	resume?: boolean;
	/** Specific session ID to resume or pre-assign. When resuming, agents that
	 *  support targeted resume (e.g. Claude --resume <id>) use this instead of
	 *  --continue. For fresh launches, Claude uses --session-id <id>. */
	sessionId?: string;
	/** When true, skip injecting the dev3 protocol out-of-band (Claude:
	 *  --append-system-prompt; Codex: `-c developer_instructions=...`).
	 *  Used for review agents that rely on hooks instead of system-prompt instructions. */
	skipSystemPrompt?: boolean;
	/** Path to the generated settings file that routes the Claude statusLine
	 *  through `dev3 statusline` (rate-limit capture + delegation to the user's
	 *  original statusLine). Injected as `--settings <path>` for Claude-based
	 *  agents. Set automatically by resolveCommandForAgent/resolveCommandForProject
	 *  when rate-limit tracking is enabled. */
	statuslineSettingsFile?: string;
	/** The LLM backend selected for this agent. The provider registry decides how
	 *  the pinned model is delivered: via injected env (Claude on Bedrock —
	 *  ANTHROPIC_MODEL, --model omitted) or via a rewritten --model value plus
	 *  routing args (Codex on Bedrock — `-c model_provider="amazon-bedrock"`). */
	llmProvider?: LlmProvider;
	/** Per-launch managed account selection (agent account switcher). `undefined`
	 *  → use the registry default (the preselect); `null` → force the system
	 *  login (~/.claude / ~/.codex); a string → that specific managed account.
	 *  Threaded into the account env resolution so each spawned session locks to
	 *  its chosen account instead of a single global active one. */
	accountId?: string | null;
}

/**
 * Build a minimal resume command for a given agent command name and session ID.
 * Used for resuming sessions after tmux death / app restart. Delegated to the
 * agent adapter (single source of truth for resume syntax + capability).
 */
export function buildResumeCommand(agentCmd: string, sessionId?: string): string | null {
	return getAgentAdapter(agentCmd).buildResumeCommand(agentCmd, sessionId);
}

/** Returns true when the agent CLI supports session resumption. */
export function supportsResume(baseCmd: string): boolean {
	return getAgentAdapter(baseCmd).supportsResume;
}

/** Returns true when the agent supports pre-assigned session IDs at launch time
 *  (accept a UUID on first launch and resume it later by ID). See each adapter
 *  for the per-agent details (e.g. Codex/OpenCode cannot pre-assign). */
export function supportsPreAssignedSessionId(baseCmd: string): boolean {
	return getAgentAdapter(baseCmd).supportsPreAssignedSessionId;
}

/**
 * Assemble the full launch command for an agent. All per-agent flag/quote/order
 * logic lives in the selected AgentAdapter (decision 124); this resolves the
 * impure inputs the pure adapter needs — the third-party-provider skip-model
 * rule and the Codex theme/profile runtime — and threads them in.
 */
export function resolveAgentCommand(
	agent: CodingAgent,
	config: AgentConfiguration | undefined,
	ctx: TemplateContext,
	options?: CommandOptions,
): string {
	const baseCmd = config?.baseCommandOverride || agent.baseCommand;
	const adapter = getAgentAdapter(baseCmd);

	const adapterOptions: AdapterLaunchOptions = {
		resume: options?.resume,
		sessionId: options?.sessionId,
		skipSystemPrompt: options?.skipSystemPrompt,
		statuslineSettingsFile: options?.statuslineSettingsFile,
		// Under an env-delivering backend (e.g. Bedrock for Claude) the model comes
		// from injected env (ANTHROPIC_MODEL), so the adapter omits --model.
		skipModelForProvider: providerOmitsModelFlag(options?.llmProvider),
		// Backend routing args (e.g. Codex on Bedrock), shell-escaped by the adapter.
		providerArgs: getProviderDefinition(options?.llmProvider)?.enableArgs,
		// Codex-only: resolve the theme/profile runtime (impure) here so the pure
		// adapter stays pure. Non-Codex agents skip it (avoids the codex --help probe).
		codex: adapter.command === "codex" ? codexLaunchRuntime() : undefined,
	};

	return adapter.launchArgs(baseCmd, config, ctx, adapterOptions).join(" ");
}

export function findConfig(
	agent: CodingAgent,
	configId: string | null | undefined,
): AgentConfiguration | undefined {
	if (!configId) {
		// Fall back to agent's defaultConfigId, then first config
		return (
			agent.configurations.find((c) => c.id === agent.defaultConfigId) ||
			agent.configurations[0]
		);
	}
	return (
		agent.configurations.find((c) => c.id === configId) ||
		agent.configurations[0]
	);
}

/** Default env vars injected for Claude-based agents. */
export const CLAUDE_DEFAULT_ENV: Record<string, string> = {
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
	CLAUDE_CODE_NO_FLICKER: "1",
};

/** Build default env vars for an agent based on its base command. */
export function getDefaultEnvForAgent(agent: CodingAgent, config?: AgentConfiguration): Record<string, string> {
	const baseCmd = config?.baseCommandOverride || agent.baseCommand;
	if (isClaudeCommand(baseCmd)) {
		return { ...CLAUDE_DEFAULT_ENV };
	}
	return {};
}

/** Attach the dev3-managed Claude settings file to CommandOptions. The file
 *  always suppresses the one-time bypass-permission confirmation
 *  (skipDangerousModePermissionPrompt), so it is injected regardless of
 *  rate-limit tracking; the statusLine wrapper is included only when tracking is
 *  on. Only Claude's adapter reads the option — other agents ignore it. */
function applyStatusLineOption(
	options: CommandOptions | undefined,
	settings: { agentRateLimitTracking?: boolean },
): CommandOptions | undefined {
	const includeStatusLine = settings.agentRateLimitTracking !== false;
	const settingsFile = ensureClaudeStatusLineSettings(includeStatusLine);
	if (!settingsFile) return options;
	return { ...options, statuslineSettingsFile: settingsFile };
}

/** Inject the active managed account's env into Claude-based commands (agent
 *  account switcher): CLAUDE_CONFIG_DIR for OAuth accounts, plus ANTHROPIC_*
 *  and extra vars for API profiles. An explicit CLAUDE_CONFIG_DIR in the
 *  config's envVars disables the injection entirely, and per-key values set by
 *  the config always win. Affects new sessions only; running agents keep their
 *  in-memory credentials. */
async function applyClaudeAccountEnv(
	baseCmd: string,
	extraEnv: Record<string, string>,
	accountId?: string | null,
): Promise<void> {
	if (!isClaudeCommand(baseCmd) || extraEnv.CLAUDE_CONFIG_DIR) return;
	try {
		const accountEnv = await getActiveClaudeSessionEnv(accountId);
		for (const [key, value] of Object.entries(accountEnv)) {
			if (!(key in extraEnv)) extraEnv[key] = value;
		}
	} catch (err) {
		log.warn("Failed to resolve active Claude account env", { error: String(err) });
	}
}

/** Inject the selected Codex account's CODEX_HOME into a Codex launch. Mirrors
 *  applyClaudeAccountEnv: an explicit CODEX_HOME in the config's envVars disables
 *  the injection, and `accountId` selects a specific account for THIS session
 *  (per-launch selector). Affects new sessions only. */
async function applyCodexAccountEnv(
	baseCmd: string,
	extraEnv: Record<string, string>,
	accountId?: string | null,
): Promise<void> {
	// Codex account switcher is an orthogonal feature (kept in front of the
	// adapter seam); a plain command-name gate suffices here.
	if (agentKey(baseCmd) !== "codex" || extraEnv.CODEX_HOME) return;
	try {
		const accountEnv = await getActiveCodexSessionEnv(accountId);
		for (const [key, value] of Object.entries(accountEnv)) {
			if (!(key in extraEnv)) extraEnv[key] = value;
		}
	} catch (err) {
		log.warn("Failed to resolve active Codex account env", { error: String(err) });
	}
}

/** Classify a concrete Claude model id into its alias family. dev3 presets pass
 *  concrete ids (`claude-opus-4-8[1m]`, `claude-sonnet-5`, `claude-fable-5`), not
 *  the `opus`/`sonnet`/… aliases, so alias-default env vars alone never bind —
 *  we map the id to a family and rewrite the `--model` flag (applyModelOverride). */
export function claudeModelFamily(modelId: string): "opus" | "sonnet" | "haiku" | "fable" | null {
	const m = modelId.toLowerCase();
	if (m.includes("opus")) return "opus";
	if (m.includes("sonnet")) return "sonnet";
	if (m.includes("haiku")) return "haiku";
	if (m.includes("fable")) return "fable";
	return null;
}

/** Rewrite a Claude preset's `--model` flag to the active API profile's override.
 *  Claude Code gives the CLI flag precedence over env, and dev3 presets pass
 *  concrete model ids — so without rewriting the flag, an API profile's per-slot
 *  (`ANTHROPIC_DEFAULT_<FAMILY>_MODEL`) or master model would silently never
 *  apply. Preference order: the preset id's family slot, then a bare
 *  ANTHROPIC_MODEL escape hatch (e.g. a manual config env var). Claude only. */
export function applyModelOverride(
	config: AgentConfiguration | undefined,
	baseCmd: string,
	extraEnv: Record<string, string>,
): AgentConfiguration | undefined {
	// No config → no --model flag is emitted, so any env var wins on its own.
	if (!config?.model || !isClaudeCommand(baseCmd)) return config;
	// ENV_UNSET sentinels (cleared vars after an account switch) are "not set".
	const pick = (v: string | undefined) => (v && v !== ENV_UNSET ? v : undefined);
	const family = claudeModelFamily(config.model);
	const familyOverride = family ? pick(extraEnv[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]) : undefined;
	const override = familyOverride ?? pick(extraEnv.ANTHROPIC_MODEL);
	if (!override) return config;
	return { ...config, model: override };
}

/** Apply saved binary path override if the cached file still exists on disk. */
function applyBinaryPathOverride(agent: CodingAgent, savedPaths: Record<string, string> | undefined): CodingAgent {
	const savedPath = savedPaths?.[agent.id];
	return savedPath && existsSync(savedPath)
		? { ...agent, baseCommand: savedPath }
		: agent;
}

export async function resolveCommandForAgent(
	agentId: string,
	configId: string | null,
	ctx: TemplateContext,
	options?: CommandOptions,
): Promise<{ command: string; agent: CodingAgent; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const allAgents = await getAllAgents();
	const agent = allAgents.find((a) => a.id === agentId);
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`);
	}
	const config = findConfig(agent, configId);

	const settings = await loadSettings();
	const agentWithPath = applyBinaryPathOverride(agent, settings.agentBinaryPaths);

	// Resolve the session env BEFORE building the command: an active API
	// profile's model override must rewrite the preset's --model flag.
	const baseCmd = config?.baseCommandOverride || agentWithPath.baseCommand;
	const providerOpts = withProviderOptions(applyStatusLineOption(options, settings), agentWithPath, config);
	// Order: agent-type defaults → provider env (Bedrock) → config envVars
	// (wins last, so an explicit envVars override still applies) → managed
	// account env (fills only keys not already set, so all of the above win).
	const extraEnv: Record<string, string> = {
		...getDefaultEnvForAgent(agent, config),
		...providerEnvForAgent(agentWithPath, config),
	};
	if (config?.envVars) {
		Object.assign(extraEnv, config.envVars);
	}
	await applyClaudeAccountEnv(baseCmd, extraEnv, options?.accountId);
	await applyCodexAccountEnv(baseCmd, extraEnv, options?.accountId);
	const command = resolveAgentCommand(
		agentWithPath,
		applyModelOverride(applyProviderModel(config, agentWithPath), baseCmd, extraEnv),
		ctx,
		providerOpts,
	);
	return { command, agent, config, extraEnv };
}

/** The provider selected on this agent, but only if it's a backend actually
 *  registered for this agent's command (defends against a stale/mismatched id). */
function agentProvider(agent: CodingAgent, config: AgentConfiguration | undefined): LlmProvider | undefined {
	const def = getProviderDefinition(agent.llmProvider);
	if (!def) return undefined;
	const baseCmd = (config?.baseCommandOverride || agent.baseCommand).split("/").pop() ?? "";
	return def.agentCommand === baseCmd ? agent.llmProvider : undefined;
}

/** For backends that deliver the model via the --model flag (no `modelEnv`,
 *  e.g. Codex on Bedrock), rewrite the config's model alias to the pinned
 *  provider-native id. No-op for env-delivering backends and the native default. */
export function applyProviderModel(
	config: AgentConfiguration | undefined,
	agent: CodingAgent,
): AgentConfiguration | undefined {
	const provider = agentProvider(agent, config);
	const def = getProviderDefinition(provider);
	if (!def || def.modelEnv || !config?.model) return config;
	const pinned = providerPinnedModel(provider, agent.providerConfig, config.model);
	return pinned ? { ...config, model: pinned } : config;
}

/** Provider env to inject for this agent's launch under its selected backend.
 *  Empty for the native (default) provider or an agent with no backend. */
function providerEnvForAgent(
	agent: CodingAgent,
	config: AgentConfiguration | undefined,
): Record<string, string> {
	return buildProviderEnv(agentProvider(agent, config), agent.providerConfig, config?.model);
}

/** Attach the agent's selected provider to CommandOptions, so
 *  resolveAgentCommand omits the --model alias under a third-party backend. */
function withProviderOptions(
	options: CommandOptions | undefined,
	agent: CodingAgent,
	config: AgentConfiguration | undefined,
): CommandOptions {
	const provider = agentProvider(agent, config);
	if (!provider) return options ?? {};
	return { ...options, llmProvider: provider };
}

export async function resolveCommandForProject(
	project: Project,
	taskTitle: string,
	taskDescription: string,
	worktreePath: string,
	configId?: string | null,
	options?: CommandOptions,
): Promise<{ command: string; agent: CodingAgent | null; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const ctx: TemplateContext = {
		taskTitle,
		taskDescription,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	const settings = await loadSettings();
	const allAgents = await getAllAgents();
	const agent = allAgents.find((a) => a.id === settings.defaultAgentId);

	if (agent) {
		const agentWithPath = applyBinaryPathOverride(agent, settings.agentBinaryPaths);
		const resolvedConfigId = configId ?? settings.defaultConfigId;
		const config = findConfig(agent, resolvedConfigId);
		// Env before command — see resolveCommandForAgent (API profile model override).
		const baseCmd = config?.baseCommandOverride || agentWithPath.baseCommand;
		const providerOpts = withProviderOptions(applyStatusLineOption(options, settings), agentWithPath, config);
		// Order: agent-type defaults → provider env (Bedrock) → config envVars
		// (via buildTaskEnv, wins last) → managed account env (fills only keys
		// not already set, so all of the above win).
		const agentDefaults = getDefaultEnvForAgent(agent, config);
		const extraEnv = {
			...agentDefaults,
			...providerEnvForAgent(agentWithPath, config),
			...buildTaskEnv(project, taskTitle, "", worktreePath, config),
		};
		await applyClaudeAccountEnv(baseCmd, extraEnv, options?.accountId);
		await applyCodexAccountEnv(baseCmd, extraEnv, options?.accountId);
		const command = resolveAgentCommand(
			agentWithPath,
			applyModelOverride(applyProviderModel(config, agentWithPath), baseCmd, extraEnv),
			ctx,
			providerOpts,
		);
		return { command, agent, config, extraEnv };
	}

	log.warn("Default agent not found, falling back to bash", {
		agentId: settings.defaultAgentId,
	});

	return {
		command: "bash",
		agent: null,
		config: undefined,
		extraEnv: buildTaskEnv(project, taskTitle, "", worktreePath),
	};
}

export function buildTaskEnv(
	project: Project,
	taskTitle: string,
	taskId: string,
	worktreePath: string,
	config?: AgentConfiguration,
): Record<string, string> {
	const env: Record<string, string> = {
		DEV3_TASK_TITLE: taskTitle,
		DEV3_TASK_ID: taskId,
		DEV3_PROJECT_NAME: project.name,
		DEV3_PROJECT_PATH: project.path,
		DEV3_WORKTREE_PATH: worktreePath,
	};

	// Merge config-level env vars
	if (config?.envVars) {
		Object.assign(env, config.envVars);
	}

	return env;
}

// ---- Gemini Trust ----

const CODEX_CONFIG = `${homedir()}/.codex/config.toml`;

const GEMINI_TRUSTED_FOLDERS = `${homedir()}/.gemini/trustedFolders.json`;

/**
 * Ensure a directory is marked as trusted in ~/.gemini/trustedFolders.json so
 * that `gemini` CLI skips the "Do you trust the files in this folder?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 */
export async function ensureGeminiTrust(dirPath: string): Promise<void> {
	try {
		const resolved = await realpath(dirPath);
		const file = Bun.file(GEMINI_TRUSTED_FOLDERS);
		let data: Record<string, string> = {};
		if (await file.exists()) {
			data = await file.json();
		}

		if (data[resolved] === "TRUST_FOLDER") {
			return; // already trusted
		}

		data[resolved] = "TRUST_FOLDER";

		await Bun.write(GEMINI_TRUSTED_FOLDERS, JSON.stringify(data, null, 2));
		log.info("Registered worktree as trusted in ~/.gemini/trustedFolders.json", { path: resolved });
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register Gemini worktree trust", { error: String(err) });
	}
}

// ---- Codex Trust ----

/**
 * Ensure a directory is marked as trusted in ~/.codex/config.toml so that
 * `codex` CLI skips the "Do you trust the contents of this directory?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 */
export async function ensureCodexTrust(dirPath: string): Promise<void> {
	try {
		const resolved = await realpath(dirPath);
		const home = homedir();
		const worktreesPath = `${home}/.dev3.0/worktrees`;
		const socketsPath = `${home}/.dev3.0/sockets`;

		let content: string | null = null;
		try {
			content = readFileSync(CODEX_CONFIG, "utf-8");
		} catch {
			// File doesn't exist yet — create with defaults below.
		}

		const updated = ensureCodexConfig(content, worktreesPath, socketsPath, [worktreesPath, resolved], {
			codexVersion: getCodexVersionCached(),
		});
		if (updated === content) {
			return;
		}

		writeFileSync(CODEX_CONFIG, updated, "utf-8");
		log.info("Registered worktree as trusted in ~/.codex/config.toml", { path: resolved });
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register Codex worktree trust", { error: String(err) });
	}
}

// ---- Claude Trust ----

const CLAUDE_JSON = `${homedir()}/.claude.json`;

const TRUST_ENTRY = {
	allowedTools: [],
	hasTrustDialogAccepted: true,
	projectOnboardingSeenCount: 1,
	hasCompletedProjectOnboarding: true,
	hasClaudeMdExternalIncludesApproved: false,
	mcpServers: {},
	enabledMcpjsonServers: [],
	disabledMcpjsonServers: [],
	mcpContextUris: [],
	ignorePatterns: [],
};

/**
 * Ensure a directory is marked as trusted in ~/.claude.json so that
 * `claude` CLI skips the "Do you trust this folder?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 *
 * If `projectPath` is provided and the worktree contains a `.mcp.json`,
 * also pre-approves the project's MCP servers by writing
 * `enableAllProjectMcpServers: true` (mirroring the user's "yes_all" choice)
 * into `<worktreePath>/.claude/settings.local.json`. Any explicit
 * approvals/rejections from `<projectPath>/.claude/settings.local.json` or
 * `<projectPath>/.claude/settings.json` are preserved.
 */
export async function ensureClaudeTrust(dirPath: string, projectPath?: string, accountId?: string | null): Promise<void> {
	try {
		// Resolve symlinks so the path matches what claude sees
		const resolved = await realpath(dirPath);

		await writeClaudeTrustEntry(CLAUDE_JSON, resolved);

		// A managed account (agent account switcher) reads trust from ITS OWN
		// .claude.json inside the CLAUDE_CONFIG_DIR we inject — register there too,
		// or every launch under a switched account re-asks the trust dialog. Use the
		// per-launch account (falls back to the registry default when undefined).
		try {
			const accountDir = await getActiveClaudeConfigDir(accountId);
			if (accountDir) {
				await writeClaudeTrustEntry(join(accountDir, ".claude.json"), resolved);
			}
		} catch (err) {
			log.warn("Failed to register trust in active account dir", { error: String(err) });
		}
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register worktree trust", { error: String(err) });
	}

	try {
		ensureClaudeMcpApproved(dirPath, projectPath);
	} catch (err) {
		log.warn("Failed to pre-approve Claude MCP servers", { error: String(err) });
	}
}

/** Mark `resolvedPath` as trusted inside one `.claude.json` file (idempotent). */
async function writeClaudeTrustEntry(claudeJsonPath: string, resolvedPath: string): Promise<void> {
	const file = Bun.file(claudeJsonPath);
	let data: any = {};
	if (await file.exists()) {
		data = await file.json();
	}

	if (!data.projects) {
		data.projects = {};
	}

	if (!data.projects[resolvedPath]?.hasTrustDialogAccepted) {
		data.projects[resolvedPath] = {
			...TRUST_ENTRY,
			...(data.projects[resolvedPath] || {}),
			hasTrustDialogAccepted: true,
		};

		await Bun.write(claudeJsonPath, JSON.stringify(data, null, 2));
		log.info("Registered worktree as trusted", { file: claudeJsonPath, path: resolvedPath });
	}
}

/**
 * Pre-approve project-scoped MCP servers (from `.mcp.json`) so that Claude
 * Code does not prompt the user every time a new worktree spawns.
 *
 * Claude Code reads approvals from `<cwd>/.claude/settings.local.json`
 * (the `localSettings` source). Worktrees are fresh checkouts; the gitignored
 * `settings.local.json` is never carried over, so without seeding it the user
 * faces the "N new MCP servers found in .mcp.json" prompt on every launch.
 *
 * Strategy:
 *   1. If the worktree has no `.mcp.json` → nothing to do.
 *   2. Compute the desired payload by merging (in order, later wins):
 *        - default: `{ enableAllProjectMcpServers: true }`
 *        - any MCP-related fields from `<projectPath>/.claude/settings.json`
 *        - any MCP-related fields from `<projectPath>/.claude/settings.local.json`
 *      This preserves explicit approvals/rejections the user already made
 *      in the project root, while defaulting to "trust everything" — which
 *      matches the trust level dev3 already grants the worktree via the
 *      trust dialog bypass.
 *   3. Merge into the worktree's existing `.claude/settings.local.json`
 *      (if any) and write back.
 */
function ensureClaudeMcpApproved(worktreePath: string, projectPath?: string): void {
	const mcpJsonPath = join(worktreePath, ".mcp.json");
	if (!existsSync(mcpJsonPath)) return;

	const localSettingsPath = join(worktreePath, ".claude", "settings.local.json");
	const projectSources: Array<string | undefined> = projectPath
		? [join(projectPath, ".claude", "settings.json"), join(projectPath, ".claude", "settings.local.json")]
		: [];

	const existing: Record<string, unknown> = safeReadJson(localSettingsPath) ?? {};

	const merged = mergeMcpApproval(existing, projectSources.map(safeReadJson));
	if (jsonEqual(existing, merged)) return;

	mkdirSync(dirname(localSettingsPath), { recursive: true });
	writeFileSync(localSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	log.info("Pre-approved Claude MCP servers in worktree settings.local.json", {
		path: localSettingsPath,
		enableAllProjectMcpServers: merged.enableAllProjectMcpServers,
		enabled: merged.enabledMcpjsonServers,
		disabled: merged.disabledMcpjsonServers,
	});
}

/** Pure merge: existing worktree settings + project-source settings → result.
 *  Exported for unit testing. */
export function mergeMcpApproval(
	existing: Record<string, unknown>,
	projectSources: Array<Record<string, unknown> | null>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...existing };

	const collected: {
		enableAll?: boolean;
		enabled: Set<string>;
		disabled: Set<string>;
	} = {
		enableAll: undefined,
		enabled: new Set(asStringArray(existing.enabledMcpjsonServers)),
		disabled: new Set(asStringArray(existing.disabledMcpjsonServers)),
	};
	if (typeof existing.enableAllProjectMcpServers === "boolean") {
		collected.enableAll = existing.enableAllProjectMcpServers;
	}

	for (const src of projectSources) {
		if (!src) continue;
		if (typeof src.enableAllProjectMcpServers === "boolean") {
			collected.enableAll = src.enableAllProjectMcpServers;
		}
		for (const name of asStringArray(src.enabledMcpjsonServers)) collected.enabled.add(name);
		for (const name of asStringArray(src.disabledMcpjsonServers)) collected.disabled.add(name);
	}

	// Fallback default: approve everything. Matches the implicit trust granted
	// to a dev3 worktree (we already bypass the trust dialog). An explicit
	// `false` in any project source above wins over this default.
	if (collected.enableAll === undefined) collected.enableAll = true;

	result.enableAllProjectMcpServers = collected.enableAll;
	if (collected.enabled.size > 0) result.enabledMcpjsonServers = [...collected.enabled];
	if (collected.disabled.size > 0) result.disabledMcpjsonServers = [...collected.disabled];
	return result;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function safeReadJson(path: string | undefined): Record<string, unknown> | null {
	if (!path) return null;
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
