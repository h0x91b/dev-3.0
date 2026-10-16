import { DEFAULT_REVIEW_AGENT_ID, DEFAULT_REVIEW_CONFIG_ID, type ColumnAgentConfig } from "./column-agents";
import type { LlmProvider, ProviderConfig } from "./model-routing";

// ---- Coding Agents ----

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan" | "auto";
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export interface AgentConfiguration {
	id: string;
	name: string;
	model?: string;
	permissionMode?: PermissionMode;
	effort?: EffortLevel;
	maxBudgetUsd?: number;
	appendPrompt?: string;
	additionalArgs?: string[];
	envVars?: Record<string, string>;
	baseCommandOverride?: string;
	/** Presentation-only override for the picker's 2nd field ("Model" group).
	 *  When set, this preset groups under `groupLabel` instead of the label
	 *  derived from `model` — used where the meaningful primary axis is not the
	 *  model (e.g. an OpenCode persona). Optional; never affects command
	 *  resolution or storage (the flat `id`/`configId` remains the key). */
	groupLabel?: string;
	/** Presentation-only override for the picker's 3rd field ("Mode" leaf) label.
	 *  When set, overrides the label derived from `permissionMode`+`effort` (or
	 *  the preset name minus its model). Optional; presentation only. */
	modeLabel?: string;
	/** Preset version. When the default version is bumped, stored additionalArgs
	 *  and model are reset to the new defaults. */
	version?: number;
	/** When true, this preset only works while the pxpipe token-saving proxy is
	 *  enabled in Global Settings — it routes `ANTHROPIC_BASE_URL` through the
	 *  local proxy (`127.0.0.1:${PXPIPE_PROXY_PORT}`). The picker still SHOWS it,
	 *  but renders it disabled until the user opts in (clicking it deep-links to
	 *  the Settings section). See PxpipeProxyStatus + decisions/112. */
	requiresPxpipeProxy?: boolean;
	/**
	 * Model roles: this preset's binding of catalog models to the roles its own
	 * agent CLI exposes (role id → catalog model id, see `src/shared/model-catalog.ts`).
	 * Bound by id so renaming a catalog model does not break the preset. When set,
	 * the launch goes through the proxy sidecar; when absent, nothing changes.
	 */
	modelRoles?: Record<string, string>;
	/**
	 * Which revision of dev3's curated recommendations this preset was seeded
	 * from, and — after the user answered the "new models are out" prompt — the
	 * newest revision they have already seen. Stamped on decline as well as on
	 * accept: the question is "has this user been asked about revision N", and
	 * asking twice is nagging.
	 */
	seededRevision?: number;
	/**
	 * Which curated tier this preset was seeded as (`practical`, `smart`). The
	 * group label used to answer this, back when there was only one tier; a label
	 * cannot, now that a user may hold several. Absent on a preset seeded before
	 * tiers existed — that one is the practical tier, and `tierOfPreset` says so.
	 */
	seededTier?: string;
}

export interface CodingAgent {
	id: string;
	name: string;
	baseCommand: string;
	isDefault?: boolean;
	configurations: AgentConfiguration[];
	defaultConfigId?: string;
	installCommand?: string;
	installUrl?: string;
	/**
	 * LLM backend for this agent: the agent's native API (default, undefined) or a
	 * registered third-party backend (e.g. Amazon Bedrock for Claude). When set to
	 * a third-party provider, dev3 injects the provider env vars
	 * (CLAUDE_CODE_USE_BEDROCK, mapped model id) into this agent's launches and
	 * omits the native --model alias, which the provider would reject. Only agents
	 * with a registered backend (see PROVIDER_REGISTRY) expose this.
	 */
	llmProvider?: LlmProvider;
	/** Per-provider connection settings for this agent (model override, inference-profile region). */
	providerConfig?: ProviderConfig;
	/**
	 * Which agent CLI this command actually is. Undefined = auto-detect from
	 * `baseCommand`, which recognizes only the five literal CLI names — a wrapper
	 * script, a shell alias or a renamed build of Claude Code got treated as an
	 * unknown CLI: no lifecycle hooks, no session resume, no dev3 protocol, no
	 * pre-assigned session id. This lets the user declare "that command IS Claude
	 * Code" and get byte-identical handling; `"none"` is the explicit opt-out.
	 */
	agentFamily?: AgentFamily;
}

/**
 * The agent CLI a command belongs to, keyed by that CLI's own command name (the
 * agent-adapter registry's key), plus `"none"` for "an unknown CLI, handle it
 * generically". Governs EVERYTHING dev3 does per agent — launch flags, session
 * resume, transcripts, trust, lifecycle hooks, skill prefix — so a differently
 * named binary runs through exactly the same code as the CLI it wraps.
 */
export type AgentFamily = "claude" | "codex" | "gemini" | "agent" | "opencode" | "copilot" | "omp" | "none";

/**
 * Which of an agent's preset models the signed-in account cannot actually select,
 * from probing the CLI's own model-list command (Codex `debug models`, Cursor
 * `--list-models`). `unknown` means dev3 could not determine it — the CLI has no
 * such command, is not logged in, or the probe failed — and the picker must then
 * filter NOTHING rather than risk hiding a usable model. `unavailable` holds the
 * raw preset `model` slugs to flag; an empty array means everything is available.
 */
export type AgentModelAvailability =
	| { status: "unknown" }
	| { status: "resolved"; unavailable: string[] };

/**
 * Prefix used to invoke an installed skill from an agent prompt. Codex reserves
 * `/` for built-in commands; omp registers one slash command per skill under a
 * `skill:` namespace. Unknown commands keep the compatible slash default.
 */
export function skillInvocationPrefix(baseCommand: string, family?: AgentFamily): "$" | "/" | "/skill:" {
	const key = family ? family : (baseCommand.split("/").pop() ?? "");
	if (key === "codex") return "$";
	return key === "omp" ? "/skill:" : "/";
}

/** Fixed port of the optional local `pxpipe-proxy` (token-saving image proxy).
 *  Matches the upstream package's default; the "Fable 5 (cost trick)" preset
 *  and the Global Settings panel both key off this. Opt-in / experimental. */
export const PXPIPE_PROXY_PORT = 47821;
export const PXPIPE_PROXY_BASE_URL = `http://127.0.0.1:${PXPIPE_PROXY_PORT}`;

type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "X-High",
	max: "Max",
	ultra: "Ultra",
};

/** Build a curated Codex model tier: popular Bypass modes first, followed by
 *  a smaller Standard set for everyday permission-aware launches. */
function createCodexReasoningPresets(
	model: string,
	modelLabel: string,
	idPrefix: string,
	bypassEfforts: readonly CodexReasoningEffort[],
	standardEfforts: readonly CodexReasoningEffort[],
): AgentConfiguration[] {
	const bypass = bypassEfforts.map((effort): AgentConfiguration => ({
		id: `${idPrefix}-${effort}-bypass`,
		name: `${modelLabel} Bypass [${CODEX_REASONING_LABELS[effort]}]`,
		model,
		groupLabel: modelLabel,
		modeLabel: `Bypass [${CODEX_REASONING_LABELS[effort]}]`,
		version: 3,
		additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", `model_reasoning_effort="${effort}"`],
	}));
	const standard = standardEfforts.map((effort): AgentConfiguration => ({
		id: `${idPrefix}-${effort}`,
		name: `${modelLabel} Standard [${CODEX_REASONING_LABELS[effort]}]`,
		model,
		groupLabel: modelLabel,
		modeLabel: `Standard [${CODEX_REASONING_LABELS[effort]}]`,
		version: 3,
		additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", `model_reasoning_effort="${effort}"`],
	}));
	return [...bypass, ...standard];
}

type OmpThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

const OMP_THINKING_LABELS: Record<OmpThinkingLevel, string> = {
	off: "Off",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "X-High",
	max: "Max",
};

/** omp's unattended mode at each thinking level — Claude's shape, where Auto and
 *  Bypass carry the effort range and the stricter modes appear once. The level
 *  rides `additionalArgs` because `EffortLevel` has no `off` or `max`, the route
 *  the Codex presets take for `max` and `ultra`. */
function createOmpBypassPresets(levels: readonly OmpThinkingLevel[]): AgentConfiguration[] {
	return levels.map((level): AgentConfiguration => ({
		id: `omp-yolo-${level}`,
		name: `Bypass (${OMP_THINKING_LABELS[level]})`,
		modeLabel: `Bypass · ${OMP_THINKING_LABELS[level]}`,
		permissionMode: "bypassPermissions",
		additionalArgs: ["--thinking", level],
		version: 1,
	}));
}

export const DEFAULT_AGENTS: CodingAgent[] = [
	{
		id: "builtin-claude",
		name: "Claude",
		baseCommand: "claude",
		isDefault: true,
		installCommand: "brew install claude-code",
		installUrl: "https://docs.anthropic.com/en/docs/claude-code",
		configurations: [
			// --- Auto (Fable 5.1 first — flagship — then Fable 5, Opus 5.5/Opus 5/Opus 4.8/Sonnet 5 effort tiers, then Opus 4.7) ---
			{ id: "claude-auto-fable51-medium", name: "Auto (Fable 5.1, Medium)", model: "claude-fable-5-1[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable51-high", name: "Auto (Fable 5.1, High)", model: "claude-fable-5-1[1m]", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable51-xhigh", name: "Auto (Fable 5.1, X-High)", model: "claude-fable-5-1[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-medium", name: "Auto (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-high", name: "Auto (Fable 5, High)", model: "claude-fable-5", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-xhigh", name: "Auto (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus55-medium", name: "Auto (Opus 5.5, Medium)", model: "claude-opus-5-5[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-medium", name: "Auto (Opus 5, Medium)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus55-high", name: "Auto (Opus 5.5, High)", model: "claude-opus-5-5[1m]", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-high", name: "Auto (Opus 5, High)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus55-xhigh", name: "Auto (Opus 5.5, X-High)", model: "claude-opus-5-5[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-xhigh", name: "Auto (Opus 5, X-High)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-medium", name: "Auto (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-xhigh", name: "Auto (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet55-medium", name: "Auto (Sonnet 5.5, Medium)", model: "claude-sonnet-5-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-medium", name: "Auto (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet55-xhigh", name: "Auto (Sonnet 5.5, X-High)", model: "claude-sonnet-5-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-xhigh", name: "Auto (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-haiku55", name: "Auto (Haiku 5.5)", model: "claude-haiku-5-5", permissionMode: "auto", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus47", name: "Auto (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "auto", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Bypass (same model order as Auto) ---
			{ id: "claude-bypass-fable51-medium", name: "Bypass (Fable 5.1, Medium)", model: "claude-fable-5-1[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable51-high", name: "Bypass (Fable 5.1, High)", model: "claude-fable-5-1[1m]", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable51-xhigh", name: "Bypass (Fable 5.1, X-High)", model: "claude-fable-5-1[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-medium", name: "Bypass (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-high", name: "Bypass (Fable 5, High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-xhigh", name: "Bypass (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus55-medium", name: "Bypass (Opus 5.5, Medium)", model: "claude-opus-5-5[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-medium", name: "Bypass (Opus 5, Medium)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus55-high", name: "Bypass (Opus 5.5, High)", model: "claude-opus-5-5[1m]", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-high", name: "Bypass (Opus 5, High)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus55-xhigh", name: "Bypass (Opus 5.5, X-High)", model: "claude-opus-5-5[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-xhigh", name: "Bypass (Opus 5, X-High)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-medium", name: "Bypass (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet55-medium", name: "Bypass (Sonnet 5.5, Medium)", model: "claude-sonnet-5-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-medium", name: "Bypass (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet55-xhigh", name: "Bypass (Sonnet 5.5, X-High)", model: "claude-sonnet-5-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-xhigh", name: "Bypass (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-haiku55", name: "Bypass (Haiku 5.5)", model: "claude-haiku-5-5", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus47", name: "Bypass (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Default (Claude's normal permission mode). No hard bypass flag:
			//     the adapter injects --allow-dangerously-skip-permissions so bypass
			//     is available to toggle into (Shift+Tab) but is NOT on by default.
			//     Versions bumped so the old hard --dangerously-skip-permissions is
			//     dropped from already-stored copies (mergeConfig discards user
			//     additionalArgs when the preset version advances). ---
			{ id: "claude-default-fable51", name: "Default (Fable 5.1)", model: "claude-fable-5-1[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default", name: "Default (Fable 5)", model: "claude-fable-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 9 },
			{ id: "claude-default-opus55", name: "Default (Opus 5.5)", model: "claude-opus-5-5[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default-opus5", name: "Default (Opus 5)", model: "claude-opus-5[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default-opus48", name: "Default (Opus 4.8)", model: "claude-opus-4-8[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			{ id: "claude-default-sonnet55", name: "Default (Sonnet 5.5)", model: "claude-sonnet-5-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default-sonnet5", name: "Default (Sonnet 5)", model: "claude-sonnet-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			{ id: "claude-default-haiku55", name: "Default (Haiku 5.5)", model: "claude-haiku-5-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Plan ---
			// Plan mode: the allow-bypass flag is now injected by the claude adapter
			// for every session, so it is not repeated here (single source).
			{ id: "claude-plan-fable51", name: "Plan (Fable 5.1)", model: "claude-fable-5-1[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan", name: "Plan (Fable 5)", model: "claude-fable-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 9 },
			{ id: "claude-plan-opus55", name: "Plan (Opus 5.5)", model: "claude-opus-5-5[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-opus5", name: "Plan (Opus 5)", model: "claude-opus-5[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-opus48", name: "Plan (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-sonnet55", name: "Plan (Sonnet 5.5)", model: "claude-sonnet-5-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-sonnet5", name: "Plan (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-haiku55", name: "Plan (Haiku 5.5)", model: "claude-haiku-5-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Accept Edits ---
			{ id: "claude-approvals-fable51", name: "Accept Edits (Fable 5.1)", model: "claude-fable-5-1[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals", name: "Accept Edits (Fable 5)", model: "claude-fable-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 8 },
			{ id: "claude-approvals-opus55", name: "Accept Edits (Opus 5.5)", model: "claude-opus-5-5[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-opus5", name: "Accept Edits (Opus 5)", model: "claude-opus-5[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-opus48", name: "Accept Edits (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-sonnet55", name: "Accept Edits (Sonnet 5.5)", model: "claude-sonnet-5-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-sonnet5", name: "Accept Edits (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-haiku55", name: "Accept Edits (Haiku 5.5)", model: "claude-haiku-5-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Experimental: token-saving image proxy (opt-in, disabled until enabled in Settings) ---
			// Its own Model group ("Fable 5 (cost trick)"). Fable 5 does not behave under
			// --permission-mode auto, so the cost-saving experiment offers Bypass and Default
			// (both run unattended with --dangerously-skip-permissions, like the plain Fable 5
			// presets), each across the Medium/High/X-High effort tiers. Bypass first, then
			// Default. The Mode leaf derives from permissionMode+effort ("Bypass · Medium",
			// "Default · High", …).
			{ id: "claude-fable5-cost-trick-bypass-medium", name: "Fable 5 (cost trick, Bypass, Medium)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
			{ id: "claude-fable5-cost-trick-bypass-high", name: "Fable 5 (cost trick, Bypass, High)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
			{ id: "claude-fable5-cost-trick-bypass-xhigh", name: "Fable 5 (cost trick, Bypass, X-High)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
			{ id: "claude-fable5-cost-trick-default-medium", name: "Fable 5 (cost trick, Default, Medium)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
			{ id: "claude-fable5-cost-trick-default-high", name: "Fable 5 (cost trick, Default, High)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
			{ id: "claude-fable5-cost-trick-default-xhigh", name: "Fable 5 (cost trick, Default, X-High)", model: "claude-fable-5", groupLabel: "Fable 5 (cost trick)", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", ANTHROPIC_BASE_URL: PXPIPE_PROXY_BASE_URL }, requiresPxpipeProxy: true, version: 1 },
		],
		defaultConfigId: "claude-auto-opus55-medium",
	},
	{
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		isDefault: true,
		installCommand: "brew install codex",
		installUrl: "https://github.com/openai/codex",
		configurations: [
			// Newest generation first: the picker lists model groups in this order.
			// --- GPT-6.1 Sol ---
			...createCodexReasoningPresets(
				"gpt-6.1-sol",
				"GPT-6.1 Sol",
				"codex-6.1-sol",
				["medium", "low", "high", "xhigh", "max", "ultra"],
				["medium", "low", "high", "xhigh", "max", "ultra"],
			),
			// --- GPT-6 Astra (default: Sol is rejected under a ChatGPT-account login) ---
			{
				id: "codex-default",
				name: "GPT-6 Astra Bypass [Medium] — Default",
				model: "gpt-6-astra",
				groupLabel: "GPT-6 Astra",
				modeLabel: "Bypass [Medium] — Default",
				version: 12,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="medium"'],
			},
			...createCodexReasoningPresets(
				"gpt-6-astra",
				"GPT-6 Astra",
				"codex-6-astra",
				["low", "high", "xhigh", "max", "ultra"],
				["medium", "low", "high", "xhigh", "max", "ultra"],
			),
			// --- GPT-6 Sol (frontier coding and agentic workflows) ---
			...createCodexReasoningPresets(
				"gpt-6-sol",
				"GPT-6 Sol",
				"codex-6-sol",
				["medium", "low", "high", "xhigh", "max", "ultra"],
				["medium", "low", "high", "xhigh", "max", "ultra"],
			),
			// Sol-only workflows follow the popular Bypass and Standard modes.
			{
				id: "codex-plan",
				name: "GPT-6 Sol Plan [High]",
				model: "gpt-6-sol",
				groupLabel: "GPT-6 Sol",
				modeLabel: "Plan [High]",
				version: 8,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan-then-bypass",
				name: "GPT-6 Sol Plan → Bypass [High]",
				model: "gpt-6-sol",
				groupLabel: "GPT-6 Sol",
				modeLabel: "Plan → Bypass [High]",
				version: 8,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			// --- GPT-6 Luna (focused, high-volume tasks) ---
			...createCodexReasoningPresets(
				"gpt-6-luna",
				"GPT-6 Luna",
				"codex-6-luna",
				["medium", "high", "xhigh", "max"],
				["medium", "high"],
			),
			// --- GPT-5.6 Luna (fast/affordable) ---
			...createCodexReasoningPresets(
				"gpt-5.6-luna",
				"GPT-5.6 Luna",
				"codex-5.6-luna",
				["xhigh", "max", "high", "medium"],
				["medium", "high"],
			),
			// --- GPT-5.6 Sol (frontier: everyday through deeper reasoning) ---
			...createCodexReasoningPresets(
				"gpt-5.6-sol",
				"GPT-5.6 Sol",
				"codex-5.6-sol",
				["low", "medium", "high", "xhigh", "max", "ultra"],
				["low", "medium", "high", "xhigh", "max", "ultra"],
			),
			// --- GPT-5.6 Terra (balanced: below the frontier tiers, above legacy) ---
			...createCodexReasoningPresets(
				"gpt-5.6-terra",
				"GPT-5.6 Terra",
				"codex-5.6-terra",
				["medium", "high", "xhigh"],
				["medium", "high"],
			),
			// --- GPT-5.5 (legacy) ---
			{
				id: "codex-5.4-medium-bypass",
				name: "GPT-5.5 Bypass [Medium]",
				model: "gpt-5.5",
				groupLabel: "GPT-5.5",
				modeLabel: "Bypass [Medium]",
				version: 6,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="medium"'],
			},
			{
				id: "codex-5.4-heavy-bypass",
				name: "GPT-5.5 Bypass [High]",
				model: "gpt-5.5",
				groupLabel: "GPT-5.5",
				modeLabel: "Bypass [High]",
				version: 6,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.4-medium",
				name: "GPT-5.5 Standard [Medium]",
				model: "gpt-5.5",
				groupLabel: "GPT-5.5",
				modeLabel: "Standard [Medium]",
				version: 6,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="medium"'],
			},
			{
				id: "codex-5.4-heavy",
				name: "GPT-5.5 Standard [High]",
				model: "gpt-5.5",
				groupLabel: "GPT-5.5",
				modeLabel: "Standard [High]",
				version: 6,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
		],
		defaultConfigId: "codex-default",
	},
	{
		id: "builtin-gemini",
		name: "Gemini",
		baseCommand: "gemini",
		isDefault: true,
		installCommand: "brew install gemini-cli",
		installUrl: "https://github.com/google-gemini/gemini-cli",
		configurations: [
			// --- Gemini 3.1 Pro (heavy) ---
			{ id: "gemini-default", name: "Default (3.1 Pro)", model: "gemini-3.1-pro-preview", version: 1 },
			{ id: "gemini-plan", name: "Plan (3.1 Pro)", model: "gemini-3.1-pro-preview", permissionMode: "plan", version: 1 },
			{ id: "gemini-yolo", name: "YOLO (3.1 Pro)", model: "gemini-3.1-pro-preview", permissionMode: "bypassPermissions", version: 1 },
			{ id: "gemini-auto-edit", name: "Auto Edit (3.1 Pro)", model: "gemini-3.1-pro-preview", permissionMode: "acceptEdits", version: 1 },
			// --- Gemini 3 Flash (medium) ---
			{ id: "gemini-flash", name: "Default (3 Flash)", model: "gemini-3-flash-preview", version: 1 },
			{ id: "gemini-flash-yolo", name: "YOLO (3 Flash)", model: "gemini-3-flash-preview", permissionMode: "bypassPermissions", version: 1 },
			{ id: "gemini-flash-auto-edit", name: "Auto Edit (3 Flash)", model: "gemini-3-flash-preview", permissionMode: "acceptEdits", version: 1 },
			// --- Gemini 3.1 Flash Lite (light) ---
			{ id: "gemini-flash-lite", name: "Default (3.1 Flash Lite)", model: "gemini-3.1-flash-lite-preview", version: 1 },
			{ id: "gemini-flash-lite-yolo", name: "YOLO (3.1 Flash Lite)", model: "gemini-3.1-flash-lite-preview", permissionMode: "bypassPermissions", version: 1 },
		],
		defaultConfigId: "gemini-default",
	},
	{
		id: "builtin-cursor",
		name: "Cursor Agent",
		baseCommand: "agent",
		isDefault: true,
		installCommand: "npm install -g cursor-agent",
		installUrl: "https://github.com/nicepkg/cursor-agent",
		// Cursor bakes effort/thinking/fast into the model id itself, so every id
		// below is a whole catalog slug. Only ids observed in a real
		// `cursor-agent models` run are listed — never a slug built by combining
		// a family with an effort suffix.
		// These presets deliberately carry no `version`: a version bump discards a
		// user's own model and name, and stale Cursor ids are refreshed instead by
		// RETIRED_CURSOR_PRESET_DEFAULTS (src/bun/agents.ts), which only replaces a
		// value dev3 itself shipped.
		configurations: [
			{ id: "cursor-default", name: "Default (Opus 5)", model: "claude-opus-5-thinking-high" },
			{ id: "cursor-plan", name: "Plan (Opus 5)", model: "claude-opus-5-thinking-high", permissionMode: "plan" },
			{ id: "cursor-plan-then-bypass", name: "Plan then Bypass (Opus 5)", model: "claude-opus-5-thinking-high", permissionMode: "plan", additionalArgs: ["--force"] },
			{ id: "cursor-yolo", name: "YOLO (Opus 5)", model: "claude-opus-5-thinking-high", permissionMode: "bypassPermissions" },
			{ id: "cursor-sonnet-5", name: "Sonnet 5", model: "claude-sonnet-5-thinking-high" },
			{ id: "cursor-gpt", name: "GPT-5.6 Sol X-High", model: "gpt-5.6-sol-xhigh" },
			{ id: "cursor-yolo-gpt", name: "YOLO GPT-5.6 Sol", model: "gpt-5.6-sol-xhigh", permissionMode: "bypassPermissions" },
			{ id: "cursor-grok-4-6", name: "Grok 4.6 Fast", model: "cursor-grok-4.6-high-fast" },
			// Cursor docs list Gemini 3.8 Flash, but no `cursor-agent models` dump
			// we can attribute spells its slug out — this one follows the verified
			// 3.7 shape. Requested explicitly; treat as unverified.
			{ id: "cursor-gemini-3-8", name: "Gemini 3.8 Flash", model: "gemini-3.8-flash-high" },
			{ id: "cursor-gemini", name: "Gemini 3.7 Flash", model: "gemini-3.7-flash-high" },
			{ id: "cursor-composer-2-5", name: "Composer 2.5", model: "composer-2.5" },
		],
		defaultConfigId: "cursor-default",
	},
	{
		id: "builtin-opencode",
		name: "Oh My OpenCode",
		baseCommand: "opencode",
		isDefault: true,
		installCommand: "bunx oh-my-openagent install",
		installUrl: "https://github.com/code-yeongyu/oh-my-openagent",
		configurations: [
			// --- Sisyphus (Orchestrator) ---
			{ id: "opencode-default", name: "Orchestrator / Sisyphus (Opus 4.6)", model: "anthropic/claude-opus-4-6", additionalArgs: ["--agent", "sisyphus"], version: 2 },
			{ id: "opencode-sisyphus-sonnet", name: "Orchestrator / Sisyphus (Sonnet 4.6)", model: "anthropic/claude-sonnet-4-6", additionalArgs: ["--agent", "sisyphus"], version: 2 },
			{ id: "opencode-sisyphus-gpt54", name: "Orchestrator / Sisyphus (GPT-5.5)", model: "openai/gpt-5.5", additionalArgs: ["--agent", "sisyphus"], version: 3 },
			// --- Prometheus (Planner) ---
			{ id: "opencode-prometheus", name: "Planner / Prometheus (Opus 4.6)", model: "anthropic/claude-opus-4-6", additionalArgs: ["--agent", "prometheus"], version: 2 },
			{ id: "opencode-prometheus-gpt54", name: "Planner / Prometheus (GPT-5.5)", model: "openai/gpt-5.5", additionalArgs: ["--agent", "prometheus"], version: 3 },
			// --- Atlas (Executor) ---
			{ id: "opencode-atlas", name: "Executor / Atlas (Sonnet 4.6)", model: "anthropic/claude-sonnet-4-6", additionalArgs: ["--agent", "atlas"], version: 2 },
			{ id: "opencode-atlas-gpt54", name: "Executor / Atlas (GPT-5.5)", model: "openai/gpt-5.5", additionalArgs: ["--agent", "atlas"], version: 3 },
			// --- Hephaestus (Deep Worker) ---
			{ id: "opencode-hephaestus", name: "Deep Worker / Hephaestus (GPT-5.5)", model: "openai/gpt-5.5", additionalArgs: ["--agent", "hephaestus"], version: 3 },
			{ id: "opencode-hephaestus-codex", name: "Deep Worker / Hephaestus (5.3 Codex)", model: "openai/gpt-5.3-codex", additionalArgs: ["--agent", "hephaestus"], version: 2 },
			// --- Simple (no agent) ---
			{ id: "opencode-haiku", name: "Haiku 4.5", model: "anthropic/claude-haiku-4-5", version: 1 },
			{ id: "opencode-gpt54-mini", name: "GPT-5.5", model: "openai/gpt-5.5", version: 2 },
			{ id: "opencode-big-pickle", name: "Big Pickle (Free)", model: "opencode/big-pickle", version: 1 },
		],
		defaultConfigId: "opencode-default",
	},
	{
		id: "builtin-copilot",
		name: "GitHub Copilot",
		baseCommand: "copilot",
		isDefault: true,
		installCommand: "brew install --cask copilot-cli",
		installUrl: "https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
		// The model names come from the installed CLI's own shell-completion
		// catalog, but WHICH of them an account may use is decided by its Copilot
		// plan and org policy — a blocked one fails the launch with
		// `Model "…" is not available`, and `auto` is the one that always works.
		// So `auto` leads, and every named model is an opt-in below it.
		configurations: [
			// --- Auto (Copilot picks the model) ---
			{ id: "copilot-default", name: "Default (Auto)", model: "auto", groupLabel: "Auto", modeLabel: "Default", version: 1 },
			{ id: "copilot-bypass", name: "Bypass (Auto)", model: "auto", groupLabel: "Auto", modeLabel: "Bypass", permissionMode: "bypassPermissions", version: 1 },
			{ id: "copilot-accept-edits", name: "Accept Edits (Auto)", model: "auto", groupLabel: "Auto", modeLabel: "Accept Edits", permissionMode: "acceptEdits", version: 1 },
			{ id: "copilot-plan", name: "Plan (Auto)", model: "auto", groupLabel: "Auto", modeLabel: "Plan", permissionMode: "plan", version: 1 },
			// --- Named models (subject to your Copilot plan) ---
			{ id: "copilot-opus5", name: "Claude Opus 5", model: "claude-opus-5", groupLabel: "Claude Opus 5", modeLabel: "Default", version: 1 },
			{ id: "copilot-opus5-bypass", name: "Claude Opus 5 (Bypass)", model: "claude-opus-5", groupLabel: "Claude Opus 5", modeLabel: "Bypass", permissionMode: "bypassPermissions", version: 1 },
			{ id: "copilot-sonnet5", name: "Claude Sonnet 5", model: "claude-sonnet-5", groupLabel: "Claude Sonnet 5", modeLabel: "Default", version: 1 },
			{ id: "copilot-sonnet5-bypass", name: "Claude Sonnet 5 (Bypass)", model: "claude-sonnet-5", groupLabel: "Claude Sonnet 5", modeLabel: "Bypass", permissionMode: "bypassPermissions", version: 1 },
			{ id: "copilot-gpt56-sol", name: "GPT-5.6 Sol", model: "gpt-5.6-sol", groupLabel: "GPT-5.6 Sol", modeLabel: "Default", version: 1 },
			{ id: "copilot-gpt56-sol-bypass", name: "GPT-5.6 Sol (Bypass)", model: "gpt-5.6-sol", groupLabel: "GPT-5.6 Sol", modeLabel: "Bypass", permissionMode: "bypassPermissions", version: 1 },
			// Effort rides a NAMED reasoning model only: `auto` rejects the flag and
			// refuses to launch at all.
			{ id: "copilot-gpt56-sol-bypass-xhigh", name: "GPT-5.6 Sol (Bypass, X-High)", model: "gpt-5.6-sol", groupLabel: "GPT-5.6 Sol", modeLabel: "Bypass · X-High", permissionMode: "bypassPermissions", effort: "xhigh", version: 1 },
			{ id: "copilot-gpt56-luna", name: "GPT-5.6 Luna", model: "gpt-5.6-luna", groupLabel: "GPT-5.6 Luna", modeLabel: "Default", version: 1 },
			{ id: "copilot-gpt53-codex", name: "GPT-5.3-Codex", model: "gpt-5.3-codex", groupLabel: "GPT-5.3-Codex", modeLabel: "Default", version: 1 },
			{ id: "copilot-gemini37", name: "Gemini 3.7 Flash", model: "gemini-3.7-flash", groupLabel: "Gemini 3.7 Flash", modeLabel: "Default", version: 1 },
		],
		defaultConfigId: "copilot-default",
	},
	{
		id: "builtin-omp",
		name: "Oh My Pi",
		baseCommand: "omp",
		isDefault: true,
		installCommand: "curl -fsSL https://omp.sh/install | sh",
		installUrl: "https://github.com/can1357/oh-my-pi",
		// omp reaches 60+ providers and picks its own startup model, so pinning one
		// here would launch against credentials the user may not hold; the presets
		// leave the model to omp. "Default" asks first like every other agent's:
		// the adapter passes `--approval-mode always-ask` for it, because omp's
		// own default with no flag is `yolo` (see omp-flags.ts).
		configurations: [
			{ id: "omp-default", name: "Default", version: 1 },
			{ id: "omp-write", name: "Accept Edits", permissionMode: "acceptEdits", version: 1 },
			...createOmpBypassPresets(["off", "low", "medium", "high", "xhigh", "max"]),
		],
		defaultConfigId: "omp-default",
	},
];

/** Maps config ids removed/renamed from DEFAULT_AGENTS to their closest surviving
 *  equivalent. Applied to `GlobalSettings.defaultConfigId` on load so a stale
 *  reference to a deleted preset doesn't leave "Launch Task" with no selection. */
export const DEPRECATED_DEFAULT_CONFIG_REMAP: Record<string, string> = {
	// Plain Fable 5 Auto/Bypass replaced by explicit Medium/X-High effort tiers
	// (mirrors what was done for Opus 4.8) — keep Fable users on Fable's top tier.
	"claude-auto": "claude-auto-fable5-xhigh",
	"claude-bypass": "claude-bypass-fable5-xhigh",
	"claude-auto-opus48": "claude-auto-opus48-xhigh",
	"claude-bypass-opus48": "claude-bypass-opus48-xhigh",
	"claude-dontask-opus48": "claude-auto-opus48-xhigh",
	"claude-auto-sonnet": "claude-auto-sonnet5-xhigh",
	"claude-bypass-sonnet": "claude-bypass-sonnet5-xhigh",
	"claude-default-sonnet": "claude-default-sonnet5",
	"claude-plan-sonnet": "claude-plan-sonnet5",
	"claude-approvals-sonnet": "claude-approvals-sonnet5",
	"claude-dontask-sonnet": "claude-default-sonnet5",
	"claude-dontask": "claude-approvals",
	"claude-default-opus47": "claude-auto-opus47",
	"claude-plan-opus47": "claude-auto-opus47",
	"claude-approvals-opus47": "claude-auto-opus47",
	"claude-dontask-opus47": "claude-auto-opus47",
	"claude-auto-sonnet5": "claude-auto-sonnet5-xhigh",
	"claude-bypass-sonnet5": "claude-bypass-sonnet5-xhigh",
	"claude-dontask-sonnet5": "claude-default-sonnet5",
	// Single cost-trick preset (auto + --dangerously-skip-permissions) split into
	// Bypass/Default effort tiers — the old preset skipped permissions, so map it to
	// the Bypass Medium tier (its closest surviving behavioral + effort equivalent).
	"claude-fable5-cost-trick": "claude-fable5-cost-trick-bypass-medium",
	// Shipped for one release while GPT-6 Sol held `codex-default`; Astra Bypass
	// Medium is `codex-default` again.
	"codex-6-astra-medium-bypass": "codex-default",
};

/**
 * Rewrite column-agent presets whose id was removed from DEFAULT_AGENTS. Without
 * this a stored `claude-bypass-sonnet` matches no option (the select renders
 * blank) and findConfig silently falls back to the FIRST preset in the list, so
 * the column runs a model nobody chose. Applied wherever column agents are read.
 */
export function remapColumnAgents(
	agents: Record<string, ColumnAgentConfig> | undefined,
): Record<string, ColumnAgentConfig> | undefined {
	if (!agents) return agents;
	let changed = false;
	const out: Record<string, ColumnAgentConfig> = {};
	for (const [column, config] of Object.entries(agents)) {
		// "claude-bypass-sonnet" was the hardcoded review default the UI stamped onto
		// every save, so it marks "never chosen" rather than a preference — it follows
		// the current default instead of the generic successor mapping.
		const wasStampedDefault = config.agentId === DEFAULT_REVIEW_AGENT_ID && config.configId === "claude-bypass-sonnet";
		const mapped = wasStampedDefault ? DEFAULT_REVIEW_CONFIG_ID : DEPRECATED_DEFAULT_CONFIG_REMAP[config.configId];
		if (mapped) changed = true;
		out[column] = mapped ? { ...config, configId: mapped } : config;
	}
	return changed ? out : agents;
}

/**
 * A user's "favorite" agent configuration — a thin pointer to an existing
 * (agentId, configId) preset, surfaced as a quick-pick chip on the launch
 * picker. Carries no config overrides of its own (custom tweaks live in the
 * agent editor); `uses`/`lastUsedAt` drive chip ordering and eviction. See
 * `src/shared/favorites.ts` and decisions/2026/07/11/agent-favorites.md.
 */
export interface FavoriteAgentConfig {
	agentId: string;
	configId: string;
	/** Launches with this (agentId, configId); +1 per spawned agent. Starts at 0. */
	uses: number;
	/** epoch ms; set on add and updated on every use. */
	lastUsedAt: number;
}
