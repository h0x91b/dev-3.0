import type { RPCSchema } from "electrobun/bun";
import type { ConversationMatch } from "./conversation-search-core";
import type { AgentRateLimitsReport } from "./rate-limits";

// ---- Changelog ----

export interface ChangelogEntry {
	date: string; // "2026-03-01"
	type: string; // "feature" | "fix" | "refactor" | "docs" | "chore"
	slug: string; // "system-requirements-check"
	title: string; // First sentence of content (truncated to ~120 chars)
	suggestedBy?: string; // GitHub username without @ (e.g. "roiros")
	issueUrl?: string; // Full GitHub issue URL (e.g. "https://github.com/h0x91b/dev-3.0/issues/191")
	issueRef?: string; // Short issue ref (e.g. "#191")
}

export type RendererLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimum length of a short ID prefix (task/project/label/note) accepted for
 * prefix matching. Below this, a prefix is treated as "not a prefix" (too broad
 * to disambiguate) rather than resolved to whichever entity happens to match
 * first. Single source of truth: the CLI-side resolver (`expandShortId`) and the
 * server-side `findByIdPrefix` MUST use the same threshold, or a short prefix the
 * CLI silently expands would bypass the server's own guard. See decision 102.
 */
export const ID_PREFIX_MIN_LENGTH = 8;

// ---- Data models ----

export type TaskStatus =
	| "todo"
	| "in-progress"
	| "user-questions"
	| "review-by-ai"
	| "review-by-user"
	| "review-by-colleague"
	| "completed"
	| "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = [
	"in-progress",
	"user-questions",
	"review-by-user",
	"review-by-colleague",
	"review-by-ai",
];

export const MERGE_COMPLETE_ELIGIBLE_STATUSES: TaskStatus[] = [
	"user-questions",
	"review-by-user",
	"review-by-colleague",
];

export const ALL_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
	"review-by-colleague",
	"completed",
	"cancelled",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "Agent is Working",
	"user-questions": "Has Questions",
	"review-by-ai": "AI Review",
	"review-by-user": "Your Review",
	"review-by-colleague": "PR Review",
	completed: "Completed",
	cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
	todo: "#70e3ff",
	"in-progress": "#afbaff",
	"user-questions": "#ffa353",
	"review-by-ai": "#a0aec0",
	"review-by-user": "#ffe55f",
	"review-by-colleague": "#c4a5ff",
	completed: "#3cf3b0",
	cancelled: "#ff8282",
};

export const STATUS_COLORS_LIGHT: Record<TaskStatus, string> = {
	todo: "#0891b2",
	"in-progress": "#6366f1",
	"user-questions": "#ea580c",
	"review-by-ai": "#64748b",
	"review-by-user": "#ca8a04",
	"review-by-colleague": "#8b5cf6",
	completed: "#059669",
	cancelled: "#dc2626",
};

/** Convert "#rrggbb" â "R G B" for use as CSS variable value */
export function hexToRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `${r} ${g} ${b}`;
}

/** Returns the list of statuses a task can transition to from `current`. */
export function getAllowedTransitions(current: TaskStatus): TaskStatus[] {
	if (current === "todo") {
		return ["in-progress", "completed", "cancelled"];
	}
	return ALL_STATUSES.filter((s) => s !== current);
}

// Conditional-move guards (--if-status / --if-status-not). Returns true when a
// move should be blocked given the task's current status. This is the single
// source of truth, used both by the authoritative in-lock check in data.ts and
// by pre-checks at call sites that must avoid side effects (worktree/PTY) when a
// guarded move is blocked.
export function isStatusGuardBlocked(
	status: string,
	options?: { ifStatus?: string; ifStatusNot?: string },
): boolean {
	const allowedStatuses = options?.ifStatus
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (allowedStatuses && !allowedStatuses.includes(status)) {
		return true;
	}
	const blockedStatuses = options?.ifStatusNot
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (blockedStatuses && blockedStatuses.includes(status)) {
		return true;
	}
	return false;
}

// ---- Column Agents ----

export interface ColumnAgentConfig {
	agentId: string; // e.g. "builtin-claude"
	configId: string; // e.g. "claude-bypass-sonnet"
	prompt: string; // prompt sent to the agent
}

export const DEFAULT_REVIEW_PROMPT = `Review all changes on this branch (use git diff against {baseBranch}).
Focus on: bugs, logic errors, runtime failures, duplicated code, security issues.
For medium/high severity: fix directly and commit.
For minor/cosmetic: leave alone. Do NOT break existing functionality.

As the very last step (after any commits), you MUST hand the task back to the user by moving it yourself:
- If you found problems, committed fixes, or have anything worth surfacing â add a short \`dev3 note add "<1â3 sentence summary>"\` and then run:
    dev3 task move --status user-questions
- If the diff is clean and nothing needed changing â run:
    dev3 task move --status review-by-user

Do not skip this step. Move the task exactly once, at the end.`;

export function getPrimaryStopTarget(autoReviewEnabled?: boolean): TaskStatus {
	return autoReviewEnabled ? "review-by-ai" : "review-by-user";
}

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
			// --- Auto (Fable 5 first — flagship — then Opus 4.8/Sonnet 5 effort tiers, then Opus 4.7) ---
			{ id: "claude-auto-fable5-medium", name: "Auto (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-xhigh", name: "Auto (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-medium", name: "Auto (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-xhigh", name: "Auto (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-medium", name: "Auto (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-xhigh", name: "Auto (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus47", name: "Auto (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "auto", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Bypass (same model order as Auto) ---
			{ id: "claude-bypass-fable5-medium", name: "Bypass (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-xhigh", name: "Bypass (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-medium", name: "Bypass (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-medium", name: "Bypass (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-xhigh", name: "Bypass (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus47", name: "Bypass (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Default (no Opus 4.7 — trimmed to a cold Auto/Bypass fallback) ---
			{ id: "claude-default", name: "Default (Fable 5)", model: "claude-fable-5", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 8 },
			{ id: "claude-default-opus48", name: "Default (Opus 4.8)", model: "claude-opus-4-8[1m]", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default-sonnet5", name: "Default (Sonnet 5)", model: "claude-sonnet-5", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Plan ---
			{ id: "claude-plan", name: "Plan (Fable 5)", model: "claude-fable-5", permissionMode: "plan", additionalArgs: ["--allow-dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 9 },
			{ id: "claude-plan-opus48", name: "Plan (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "plan", additionalArgs: ["--allow-dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-sonnet5", name: "Plan (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "plan", additionalArgs: ["--allow-dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Accept Edits ---
			{ id: "claude-approvals", name: "Accept Edits (Fable 5)", model: "claude-fable-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 8 },
			{ id: "claude-approvals-opus48", name: "Accept Edits (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-sonnet5", name: "Accept Edits (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
		],
		defaultConfigId: "claude-auto-opus48-xhigh",
	},
	{
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		isDefault: true,
		installCommand: "brew install codex",
		installUrl: "https://github.com/openai/codex",
		configurations: [
			// --- General ---
			{
				id: "codex-default",
				name: "Default (GPT-5.5 Heavy Bypass)",
				model: "gpt-5.5",
				version: 4,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan",
				name: "Plan (GPT-5.5)",
				model: "gpt-5.5",
				version: 3,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan-then-bypass",
				name: "Plan then Bypass (GPT-5.5)",
				model: "gpt-5.5",
				version: 3,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			// --- GPT-5.5 ---
			{
				id: "codex-5.4-heavy-bypass",
				name: "GPT-5.5 Heavy Bypass",
				model: "gpt-5.5",
				version: 3,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.4-heavy",
				name: "GPT-5.5 Heavy",
				model: "gpt-5.5",
				version: 3,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.4-medium-bypass",
				name: "GPT-5.5 Medium Bypass",
				model: "gpt-5.5",
				version: 3,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="medium"'],
			},
			{
				id: "codex-5.4-medium",
				name: "GPT-5.5 Medium",
				model: "gpt-5.5",
				version: 3,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="medium"'],
			},
			// --- GPT-5.3 Codex ---
			{
				id: "codex-5.3-heavy-bypass",
				name: "GPT-5.3 Codex Heavy Bypass",
				model: "gpt-5.3-codex",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.3-heavy",
				name: "GPT-5.3 Codex Heavy",
				model: "gpt-5.3-codex",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.3-medium-bypass",
				name: "GPT-5.3 Codex Medium Bypass",
				model: "gpt-5.3-codex",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="medium"'],
			},
			{
				id: "codex-5.3-medium",
				name: "GPT-5.3 Codex Medium",
				model: "gpt-5.3-codex",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="medium"'],
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
		configurations: [
			{ id: "cursor-default", name: "Default (Opus 4.6)", model: "opus-4.6-thinking" },
			{ id: "cursor-plan", name: "Plan (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "plan" },
			{ id: "cursor-plan-then-bypass", name: "Plan then Bypass (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "plan", additionalArgs: ["--force"] },
			{ id: "cursor-yolo", name: "YOLO (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "bypassPermissions" },
			{ id: "cursor-gpt", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex-high" },
			{ id: "cursor-yolo-gpt", name: "YOLO GPT-5.3 Codex", model: "gpt-5.3-codex-high", permissionMode: "bypassPermissions" },
			{ id: "cursor-gemini", name: "Gemini 3.1 Pro", model: "gemini-3.1-pro" },
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
};

export type TerminalKeymapPreset = "default" | "iterm2";

// ---- External Apps ("Open in...") ----

export interface ExternalApp {
	id: string;
	name: string;
	macAppName: string; // name used with `open -a`
}

/** Well-known macOS apps for "Open in..." menus. */
export const DEFAULT_EXTERNAL_APPS: ExternalApp[] = [
	{ id: "finder", name: "Finder", macAppName: "Finder" },
	{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor", macAppName: "Cursor" },
	{ id: "ghostty", name: "Ghostty", macAppName: "Ghostty" },
	{ id: "iterm", name: "iTerm", macAppName: "iTerm" },
	{ id: "terminal", name: "Terminal", macAppName: "Terminal" },
	{ id: "intellij", name: "IntelliJ", macAppName: "IntelliJ IDEA" },
	{ id: "intellij-ultimate", name: "IntelliJ", macAppName: "IntelliJ IDEA Ultimate" },
	{ id: "intellij-ce", name: "IntelliJ", macAppName: "IntelliJ IDEA CE" },
	{ id: "pycharm", name: "PyCharm", macAppName: "PyCharm" },
	{ id: "zed", name: "Zed", macAppName: "Zed" },
	{ id: "sublime", name: "Sublime Text", macAppName: "Sublime Text" },
];

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	taskDropPosition: "top" | "bottom";
	updateChannel: "stable" | "canary";
	theme?: "dark" | "light" | "system";
	resolvedTheme?: "dark" | "light";
	cloneBaseDirectory?: string;
	customBinaryPaths?: Record<string, string>; // requirementId â custom binary path
	agentBinaryPaths?: Record<string, string>; // agentId â resolved binary path
	terminalKeymap?: TerminalKeymapPreset;
	playSoundOnTaskComplete?: boolean;
	externalApps?: ExternalApp[]; // user-configured apps for "Open in..." menus
	tipsDisabled?: boolean;
	taskOpenMode?: "split" | "fullscreen"; // how active tasks open when clicked
	defaultDiffViewMode?: "split" | "unified" | "auto"; // default inline diff layout; "auto" picks based on screen size
	preventSleepWhileRunning?: boolean; // spawn caffeinate when agents are active
	skipQuitDialog?: boolean; // suppress the "tmux keeps running" quit confirmation
	/**
	 * Inherit the user's full exported login-shell environment into agent/MCP
	 * sessions (so env-based MCP servers, SDK keys, etc. set in `.zshrc`/`.bashrc`
	 * work). Default on; set to `false` to fall back to importing only the typed
	 * vars (PATH/LANG/...) for an isolated environment.
	 */
	importShellEnv?: boolean;
	focusMode?: boolean; // when true, suppress agent-initiated attention UI (dev3 notify/attention)
	/**
	 * Track agent rate-limit windows (Claude via an injected statusLine wrapper,
	 * Codex via rollout files) and show the ambient header indicator.
	 * Default on; set to `false` to disable both the `--settings` statusLine
	 * injection and the indicator.
	 */
	agentRateLimitTracking?: boolean;
	/**
	 * Remembered state of the Watch toggle in the launch/create-variant modal.
	 * When a task is launched, the toggle's on/off choice is persisted here and
	 * reused as the default for the next launch. Undefined â default to unwatched.
	 */
	watchByDefault?: boolean;
	/**
	 * One-time migration marker: when this is behind the app's current
	 * revision, built-in agent presets get their configuration order
	 * resynced to match the declared order in DEFAULT_AGENTS once, then
	 * this is bumped so the user's own future drag-reordering sticks again.
	 */
	agentsLayoutRevision?: number;
}

export interface TipState {
	snoozedUntil: number; // timestamp â all tips hidden until this time
	seen: Record<string, number>; // tipId â last-seen timestamp
	rotationIndex: number;
}

/** Extract repository name from a git URL (HTTPS or SSH). */
export function extractRepoName(url: string): string {
	const cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
	const lastSlash = cleaned.lastIndexOf("/");
	const lastColon = cleaned.lastIndexOf(":");
	const pos = Math.max(lastSlash, lastColon);
	const name = pos >= 0 ? cleaned.slice(pos + 1) : cleaned;
	return name || "cloned-repo";
}

// ---- Labels ----

export interface Label {
	id: string;
	name: string;
	color: string; // hex color from LABEL_COLORS palette
}

// ---- Custom Columns ----

/** Soft character cap for the LLM instruction field. Not enforced server-side. */
export const CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS = 500;

export interface CustomColumn {
	id: string;
	name: string;
	color: string; // hex color
	llmInstruction: string; // guidance for LLM on when to move tasks here
	agentConfig?: ColumnAgentConfig; // auto-spawn agent when task enters this column
}

// Colors ordered to maximize perceptual distance between consecutive picks
// (each step jumps ~150Â° around the color wheel: warmâcoolâwarmâcoolâ¦)
export const LABEL_COLORS = [
	"#ef4444", // red       0Â°
	"#14b8a6", // teal    174Â°
	"#f97316", // orange   25Â°
	"#8b5cf6", // violet  258Â°
	"#84cc16", // lime     80Â°
	"#ec4899", // pink    322Â°
	"#06b6d4", // cyan    188Â°
	"#eab308", // yellow   50Â°
	"#3b82f6", // blue    217Â°
	"#22c55e", // green   142Â°
	"#f43f5e", // rose    350Â°
	"#6366f1", // indigo  239Â°
] as const;

// ---- Repo-local config (.dev3/config.json) ----

export type CompareRefMode = "remote" | "local";
export type SetupScriptLaunchMode = "parallel" | "blocking";
export type GitHubCliAuthStatus = "authenticated" | "not_authenticated" | "not_installed";

export interface GitHubAccount {
	login: string;
	host: string;
	active: boolean;
}

export interface GitHubCliStatus {
	authStatus: GitHubCliAuthStatus;
	binaryPath: string | null;
	accounts: GitHubAccount[];
}

/** Fields that can be stored in .dev3/config.json (repo-level, shareable). */
export interface Dev3RepoConfig {
	setupScript?: string;
	setupScriptLaunchMode?: SetupScriptLaunchMode;
	devScript?: string;
	cleanupScript?: string;
	clonePaths?: string[];
	defaultBaseBranch?: string;
	defaultCompareRef?: string;
	defaultCompareRefMode?: CompareRefMode;
	autoReviewEnabled?: boolean;
	peerReviewEnabled?: boolean;
	sparseCheckoutEnabled?: boolean;
	sparseCheckoutPaths?: string[];
	builtinColumnAgents?: Record<string, ColumnAgentConfig>;
	/** Number of ports to allocate per task/worktree (injected as DEV3_PORT0..N). Default: 0. */
	portCount?: number;
}

/** Keys of Dev3RepoConfig â used for merge logic. */
export const DEV3_REPO_CONFIG_KEYS: (keyof Dev3RepoConfig)[] = [
	"setupScript",
	"setupScriptLaunchMode",
	"devScript",
	"cleanupScript",
	"clonePaths",
	"defaultBaseBranch",
	"defaultCompareRef",
	"defaultCompareRefMode",
	"autoReviewEnabled",
	"peerReviewEnabled",
	"sparseCheckoutEnabled",
	"sparseCheckoutPaths",
	"builtinColumnAgents",
	"portCount",
];

export type ConfigSource = "repo" | "local";

export interface ConfigSourceEntry {
	field: string;
	source: ConfigSource;
}

/**
 * Full provenance of a resolved config field, for `dev3 config show`.
 * Wider than ConfigSource (repo/local, used for the UI badge): it attributes
 * EVERY key to exactly one origin so the CLI never falls back to a blanket
 * label that hides where a value actually came from.
 *   local   → .dev3/config.local.json
 *   repo    → .dev3/config.json
 *   project → projects.json Project object (Project Settings → Project tab)
 *   default → built-in DEFAULTS or a derived value (e.g. defaultCompareRef)
 *   unset   → no value at any layer (rendered "(not set)")
 */
export type ResolvedConfigSource = "local" | "repo" | "project" | "default" | "unset";

export interface ProjectSettingsUpdate extends Dev3RepoConfig {
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
}

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	setupScriptLaunchMode?: SetupScriptLaunchMode;
	devScript: string;
	cleanupScript: string;
	defaultBaseBranch: string;
	defaultCompareRef?: string;
	defaultCompareRefMode?: CompareRefMode;
	// Optional project-scoped gh account selection. Empty = use the current active gh account.
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
	clonePaths?: string[];
	createdAt: string;
	deleted?: boolean;
	labels?: Label[];
	customColumns?: CustomColumn[];
	// Ordered list of TaskStatus strings and custom column IDs; absent = default order
	columnOrder?: string[];
	// When true, completed work first moves through "AI Review" before "Your Review"
	autoReviewEnabled?: boolean;
	// When false, the "PR Review" column is hidden (default: true)
	peerReviewEnabled?: boolean;
	// Sparse checkout: when enabled, only specified directories are checked out in worktrees
	sparseCheckoutEnabled?: boolean;
	sparseCheckoutPaths?: string[];
	// Column agent configs for built-in columns (keyed by TaskStatus)
	builtinColumnAgents?: Record<string, ColumnAgentConfig>;
	// User-defined display names for built-in columns (keyed by TaskStatus)
	customStatusLabels?: Record<string, string>;
	// Number of ports to allocate per task/worktree (injected as DEV3_PORT0..N)
	portCount?: number;
	/**
	 * Project kind. `"git"` (default when absent) is a normal repo-backed project
	 * with worktrees. `"virtual"` is an "Operations" board: tasks run in a managed
	 * temp dir (or a chosen folder) with NO git worktree, branch, diff, PR, or
	 * review columns. Virtual projects are stored in a separate
	 * `~/.dev3.0/virtual-projects.json` so older app versions stay forward-compatible.
	 */
	kind?: "git" | "virtual";
	/**
	 * Marks the single built-in "Operations" board. Its display name is rendered
	 * from a localized `t()` key until the user renames it (which clears this flag
	 * for naming purposes). Only ever set on virtual projects.
	 */
	builtin?: boolean;
}

/**
 * True for the single hardcoded "Operations" board â the special, pinned virtual
 * project. Distinct from user-created virtual boards (which have `kind: "virtual"`
 * but `builtin` unset). Used for pin-first ordering, the â0 shortcut, and the
 * special `[ Operations ]` / SYSTEM identity treatment.
 */
export function isBuiltinOpsProject(p: Pick<Project, "kind" | "builtin">): boolean {
	return p.builtin === true && p.kind === "virtual";
}

/**
 * Display order for any project list (dashboard tiles, switcher dropdown): the
 * built-in Operations board is pinned first; all other projects keep their
 * existing relative order. Pure + stable.
 */
export function orderProjectsForDisplay<T extends Pick<Project, "kind" | "builtin">>(projects: T[]): T[] {
	const builtin = projects.filter(isBuiltinOpsProject);
	if (builtin.length === 0) return projects;
	return [...builtin, ...projects.filter((p) => !isBuiltinOpsProject(p))];
}

/**
 * Compact git-diff stats captured for a task. For completed/cancelled git tasks
 * this is captured ONCE at completion time (in `moveTask`, before the worktree is
 * destroyed) and persisted on the task so the Productivity dashboard can sum
 * "lines changed" after the worktree is gone. `capturedAt` is the ISO time of
 * capture. Absent on tasks completed before this tracking shipped (worktree gone)
 * and on virtual (Operations) tasks (no git).
 */
export interface CompletedDiffStats {
	files: number;
	insertions: number;
	deletions: number;
	capturedAt: string;
}

export interface Task {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	description: string;
	/**
	 * Short, clean one-paragraph summary written by the agent.
	 * Surfaced in the hover-preview popover above the terminal snapshot so
	 * the user can re-enter focus fast after a long break. `description` is
	 * the raw original user request and must NOT be used as a substitute.
	 * When `userOverview` is set, it takes precedence for display â agents
	 * keep writing here freely, but the user won't see it until they revert.
	 */
	overview?: string | null;
	/**
	 * User-edited overview that OVERRIDES the agent-written `overview` in
	 * every display surface. Set when the user saves a manual edit through
	 * the UI pencil editor; cleared only when the user explicitly reverts
	 * to the AI version. Agents never read or write this field directly.
	 */
	userOverview?: string | null;
	customTitle?: string | null;
	/**
	 * True only when the user typed/edited the title through the UI (Create
	 * Task modal or inline rename). Titles set by an agent through
	 * `dev3 task update --title` leave this flag at `false`. The user-edited
	 * marker shown to agents and the CLI overwrite-guard both key off this
	 * flag â NOT off `customTitle != null` â so agent-set titles can still
	 * be re-rewritten by later agents while a real user-typed title is
	 * preserved for the entire task lifetime.
	 */
	titleEditedByUser?: boolean;
	status: TaskStatus;
	baseBranch: string;
	worktreePath: string | null;
	branchName: string | null;
	groupId: string | null;
	variantIndex: number | null;
	agentId: string | null;
	configId: string | null;
	createdAt: string;
	updatedAt: string;
	movedAt?: string;
	columnOrder?: number;
	tmuxSocket?: string | null;
	labelIds?: string[];
	existingBranch?: string | null;
	notes?: TaskNote[];
	customColumnId?: string | null;
	/**
	 * Append-only log of the task's title/overview as they changed over time.
	 * Written automatically by the data layer whenever the *effective*
	 * (displayed) title or overview changes â and seeded once at creation. Each
	 * entry is a full snapshot of both values, so it is self-contained. Not
	 * surfaced in the UI yet; kept for a future history view and for search.
	 */
	history?: TaskHistoryEntry[];
	/** True while the worktree is being created (heavy I/O in progress). */
	preparing?: boolean;
	/** Current preparation stage shown while the task is still being set up. */
	preparingStage?: PreparingStage | null;
	/** Compact 0-100 progress value for the current preparation stage. */
	preparingProgress?: number | null;
	/** ISO timestamp when preparation started. Used to detect stuck clones. */
	preparingStartedAt?: string | null;
	/** When true, native macOS notifications fire on status changes. */
	watched?: boolean;
	/** Persisted agent session state for recovery after tmux/app crash. */
	sessionState?: TaskSessionState | null;
	/**
	 * Last merge-completion prompt shown for this task. The fingerprint tracks
	 * the task branch state, so dismissing the prompt suppresses repeats until
	 * the branch changes.
	 */
	mergeCompletionPrompt?: MergeCompletionPromptState | null;
	/**
	 * True when the task was created via the "Scratch Task" button with no
	 * initial prompt. The `description` holds only a `Scratch â HH:mm`
	 * placeholder used for the title; at launch time the agent receives an
	 * empty prompt instead of the placeholder. The flag propagates from the
	 * source todo task into every variant spawned from it.
	 */
	scratch?: boolean;
	/**
	 * For tasks in a virtual ("Operations") project only: the user-chosen fixed
	 * working folder picked at creation (e.g. `~/Downloads`). When absent, the
	 * operation uses a managed temp dir under `~/.dev3.0/ops/<slug>/<taskId>/work`.
	 * On activation this resolves into `worktreePath`; on delete a managed dir is
	 * removed but a fixed folder is never auto-removed. Ignored for git projects.
	 */
	opsWorkDir?: string | null;
	/** Last-launch timestamps (ISO) per package.json script â used to sort the Scripts dropdown. */
	scriptLastRunAt?: Record<string, string>;
	/** Last-used placement per package.json script â pre-selects it in the placement picker. */
	scriptLastPlacement?: Record<string, ScriptPlacement>;
	/**
	 * Git-diff stats captured at completion time (before the worktree is removed),
	 * used by the Productivity dashboard to sum "lines changed" historically. Only
	 * set for non-virtual tasks that had a worktree when completed/cancelled.
	 * See {@link CompletedDiffStats}.
	 */
	completedDiffStats?: CompletedDiffStats | null;
	/**
	 * Images the agent surfaced to the human via `dev3 show-image`, oldest→newest.
	 * Displayed in the TaskImageViewer lightbox. Capped at
	 * {@link MAX_SHARED_IMAGES_PER_TASK}; the copied files live in the project
	 * worktree `shared-images/` dir. See {@link SharedImage}.
	 */
	sharedImages?: SharedImage[];
	/**
	 * Set when the task was created by a scheduled Automation fire (or its
	 * "Run now" action). Drives the clock provenance glyph on the task card and
	 * links the task back to its automation's run history.
	 */
	automationId?: string | null;
}

/** Per-task cap on retained shared images; oldest are pruned (files deleted) past this. */
export const MAX_SHARED_IMAGES_PER_TASK = 50;

/** Raster image extensions accepted by `dev3 show-image` (lowercase, no dot).
 * SVG is excluded on purpose — an inline data-URI SVG in the webview is an XSS
 * vector, and screenshots/renders are raster anyway. Shared by the CLI (early
 * validation) and the bun copy path (authoritative check). */
export const SHARED_IMAGE_EXTS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/** Per-image size cap for `dev3 show-image` (bytes). */
export const MAX_SHARED_IMAGE_BYTES = 25 * 1024 * 1024;

/** Max images accepted in a single `dev3 show-image` invocation. */
export const MAX_SHARED_IMAGES_PER_CALL = 20;

// ---- Package scripts runner ----

export type ScriptPlacement = "left" | "top" | "right" | "bottom" | "window";

export const SCRIPT_PLACEMENTS: readonly ScriptPlacement[] = ["left", "top", "right", "bottom", "window"] as const;

export type ScriptRunner = "bun" | "pnpm" | "yarn" | "npm";

export const SCRIPT_RUNNERS: readonly ScriptRunner[] = ["bun", "pnpm", "yarn", "npm"] as const;

export interface PackageScriptEntry {
	name: string;
	command: string;
}

export interface PackageScripts {
	/** True if a parseable package.json exists in the worktree. */
	exists: boolean;
	/** Worktree-relative path to the parsed package.json (e.g. "package.json"). */
	path: string | null;
	scripts: PackageScriptEntry[];
	runner: ScriptRunner;
	/** Runner was auto-detected from a lockfile (vs falling back to npm). */
	runnerAutoDetected: boolean;
	/** Multiple lockfiles found â runner is ambiguous. */
	multipleLockfiles: boolean;
	/** Lockfiles actually present in the worktree. */
	lockfiles: string[];
	/** Reason the package.json could not be used, if any (file missing / parse error / no scripts). */
	error: string | null;
}

/** Where a runnable entry in the Scripts dropdown comes from. */
export type ScriptSource = "package" | "make";

export const SCRIPT_SOURCES: readonly ScriptSource[] = ["package", "make"] as const;

export interface MakefileScripts {
	/** True if a readable Makefile exists in the worktree. */
	exists: boolean;
	/** Which makefile name was found (`GNUmakefile` | `makefile` | `Makefile`), or null. */
	path: string | null;
	/** Extracted targets. Reuses {@link PackageScriptEntry}: `command` is a recipe preview. */
	targets: PackageScriptEntry[];
	/** Reason the Makefile could not be used, if any (`no-makefile` / `no-targets` / read error). */
	error: string | null;
}

/** Everything the Scripts dropdown can run in one worktree: npm scripts + Makefile targets. */
export interface WorktreeScripts {
	package: PackageScripts;
	makefile: MakefileScripts;
}

/**
 * Storage key for {@link Task.scriptLastRunAt} / {@link Task.scriptLastPlacement}.
 * Package scripts keep their bare name (preserves history from before Makefile
 * support existed); make targets are namespaced so a `test` target never
 * collides with a `test` npm script. Both the renderer and the RPC handler MUST
 * use this helper so the keys agree.
 */
export function scriptStorageKey(source: ScriptSource, name: string): string {
	return source === "make" ? `make:${name}` : name;
}

export interface MergeCompletionPromptState {
	fingerprint: string;
	promptedAt: string;
	dismissedAt?: string | null;
	precise: boolean;
}

export type PreparingStage =
	| "resolving-config"
	| "fetching-origin"
	| "creating-worktree"
	| "applying-sparse-checkout"
	| "cloning-shared-paths"
	| "launching-pty";

export const PREPARING_STAGE_PROGRESS: Record<PreparingStage, number> = {
	"resolving-config": 8,
	"fetching-origin": 24,
	"creating-worktree": 48,
	"applying-sparse-checkout": 62,
	"cloning-shared-paths": 82,
	"launching-pty": 94,
};

export function getPreparingStageProgress(stage: PreparingStage): number {
	return PREPARING_STAGE_PROGRESS[stage];
}

/**
 * If a task spends longer than this on `fetching-origin`, the renderer shows
 * a stuck-preparation popover anchored to the task card pointing macOS users
 * at Full Disk Access (the most common cause of git/tmux child processes
 * silently losing access to .git/worktrees/).
 *
 * Default 60 s. Overridable at app launch via `DEV3_STUCK_PREP_THRESHOLD_SEC`
 * (resolved server-side and pushed to the renderer via
 * `getStuckPreparationThresholdMs` RPC).
 */
export const STUCK_PREPARATION_FETCH_THRESHOLD_MS = 60 * 1000;

/** Per-pane session info for recovery. */
export interface PaneSessionEntry {
	/** tmux pane ID (e.g. "%0", "%5") â stable within a tmux server lifetime, unique across sessions. */
	paneId?: string | null;
	/** The resolved agent base command (e.g. "claude", "/usr/local/bin/codex"). */
	agentCmd: string;
	/** Pre-assigned session ID (Claude --session-id). Null for agents that don't support it. */
	sessionId: string | null;
	/** Agent ID used at launch time. */
	agentId: string | null;
	/** Agent config ID used at launch time. */
	configId: string | null;
}

/** Captured session state for agent recovery after tmux death / app restart. */
export interface TaskSessionState {
	/** Panes in order â index 0 is the main pane, rest are extra agent panes. */
	panes: PaneSessionEntry[];
}

/** Returns the display title: custom override if set, otherwise auto-generated. */
export function getTaskTitle(task: Task): string {
	return task.customTitle || task.title;
}

/**
 * Returns the effective displayed overview: the user override if set, otherwise
 * the agent-written overview. Mirrors the precedence used in the task cards and
 * CLI. Returns null when neither is present.
 */
export function getTaskOverview(task: Task): string | null {
	return task.userOverview?.trim() || task.overview?.trim() || null;
}

/** What changed in a {@link TaskHistoryEntry}. */
export type TaskHistoryChange = "created" | "title" | "overview" | "both";

/**
 * One immutable snapshot of a task's displayed title + overview, captured at the
 * moment either of them changed. Append-only; see {@link Task.history}.
 */
export interface TaskHistoryEntry {
	/** ISO timestamp of the change. */
	at: string;
	/** Effective title at this point (custom override or auto-generated). */
	title: string;
	/** Effective overview at this point (user override or agent overview), or null. */
	overview: string | null;
	/** Which displayed value(s) changed and triggered this snapshot. */
	changed: TaskHistoryChange;
}

/** Humanize a status slug for display in notifications (e.g. "in-progress" â "In Progress"). */
export function formatStatus(status: string): string {
	return status
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ---- Automations (scheduled agent runs) ----

export type AutomationRunStatus = "created" | "failed" | "missed";

/** One record in an automation's bounded run history (newest first). */
export interface AutomationRun {
	id: string;
	/** ISO time of the RRULE occurrence this run satisfies (or the manual-run click time). */
	scheduledFor: string;
	/** ISO time the run actually fired; null for `missed` entries. */
	firedAt: string | null;
	status: AutomationRunStatus;
	/** The created task, when status is `created`. */
	taskId?: string | null;
	/** Failure detail, when status is `failed`. */
	error?: string | null;
	/** True when the run was triggered manually ("Run now" / `dev3 automations run`). */
	manual?: boolean;
}

/** What to do with occurrences that were missed while the app was offline. */
export type AutomationCatchUpPolicy = "skip" | "runOnce";

/**
 * A per-project scheduled agent run: an RFC 5545 RRULE subset + IANA timezone +
 * a stored prompt + an agent choice. Each fire creates an ORDINARY task
 * (worktree + tmux + agent, prompt = task description) on the board. Persisted
 * in `~/.dev3.0/data/<slug>/automations.json` (additive parallel file — older
 * app versions never read it).
 */
export interface Automation {
	id: string;
	projectId: string;
	name: string;
	/** The task description the created task gets — i.e. the agent's initial prompt. */
	prompt: string;
	/** RRULE subset string, e.g. `FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0`. See shared/rrule.ts. */
	rrule: string;
	/** IANA timezone the RRULE wall-clock times are evaluated in. */
	timezone: string;
	agentId: string | null;
	configId: string | null;
	enabled: boolean;
	catchUp: AutomationCatchUpPolicy;
	createdAt: string;
	updatedAt: string;
	/**
	 * Next occurrence (ISO, UTC) this automation should fire at — computed from
	 * the RRULE and persisted so an app restart can tell scheduled-from-missed
	 * apart. Null when disabled or the rule yields nothing.
	 */
	nextRunAt: string | null;
	/** Bounded run history, newest first. Capped at {@link MAX_AUTOMATION_RUNS_KEPT}. */
	runs: AutomationRun[];
}

/** Run-history retention per automation (newest kept). */
export const MAX_AUTOMATION_RUNS_KEPT = 20;

/** Fields accepted by the createAutomation / updateAutomation RPCs. */
export interface AutomationDraft {
	name: string;
	prompt: string;
	rrule: string;
	timezone: string;
	agentId?: string | null;
	configId?: string | null;
	enabled?: boolean;
	catchUp?: AutomationCatchUpPolicy;
}

export type NoteSource = "user" | "ai";

export interface TaskNote {
	id: string;
	content: string;
	source: NoteSource;
	createdAt: string;
	updatedAt: string;
}

/**
 * An image an agent surfaced to the human via `dev3 show-image`, bound to a task.
 * The source file is copied into the project's worktree `shared-images/` dir (next
 * to `uploads/`), so the record survives the original (often /tmp) file being
 * removed. Rendered in the {@link https://…|TaskImageViewer} lightbox with a
 * clickable history (newest activated first). Bytes reach the webview via the
 * existing `readImageBase64` RPC (works in desktop and browser transports).
 */
export interface SharedImage {
	id: string;
	/** Absolute path of the copied file under ~/.dev3.0/worktrees/<slug>/shared-images/. */
	storedPath: string;
	/** The path the agent originally passed (kept for provenance / tooltip). */
	originalPath: string;
	/** Basename of the original file. */
	name: string;
	mime: string;
	bytes: number;
	/** Optional batch caption from `dev3 show-image --caption`. */
	caption?: string;
	/** ms epoch when the image was shared. */
	createdAt: number;
}

/** Generate a short title from a description (first ~maxLen chars, word-boundary truncated). */
export function titleFromDescription(
	description: string,
	maxLen = 80,
): string {
	const text = description.replace(/\n/g, " ").trim();
	if (text.length <= maxLen) return text;
	const truncated = text.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > maxLen * 0.4) {
		return truncated.slice(0, lastSpace) + "\u2026";
	}
	return truncated + "\u2026";
}

export interface BranchStatus {
	ahead: number;
	behind: number;
	canRebase: boolean;
	insertions: number;
	deletions: number;
	unpushed: number; // -1 = never pushed, 0 = all pushed, N = N unpushed commits
	mergedByContent: boolean; // true if git diff base HEAD is empty (squash/rebase merge)
	diffFiles: number; // total files changed in branch vs base
	diffInsertions: number; // total lines added in branch vs base
	diffDeletions: number; // total lines removed in branch vs base
	diffFileStats: Array<{ path: string; insertions: number; deletions: number }>; // per-file stats for branch vs base
	prNumber: number | null; // open PR number for this branch, null if none
	prUrl: string | null; // full GitHub PR URL, null if no PR
	mergeCompletionFingerprint: string | null; // stable key for deduping the merged-branch completion prompt
}

export type TaskDiffMode = "branch" | "uncommitted" | "unpushed";

export type TaskDiffFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "type-changed"
	| "untracked"
	| "unknown";

export type TaskDiffFallbackReason = "no-upstream";

export interface TaskDiffFile {
	id: string;
	status: TaskDiffFileStatus;
	displayPath: string;
	oldPath: string | null;
	newPath: string | null;
	oldContent: string;
	newContent: string;
	hunks: string[] | null;
	insertions: number;
	deletions: number;
}

export interface TaskDiffSummary {
	files: number;
	insertions: number;
	deletions: number;
}

export type TaskDiffSkippedReason = "binary" | "too-large";

export interface TaskDiffSkippedFile {
	id: string;
	status: TaskDiffFileStatus;
	reason: TaskDiffSkippedReason;
	displayPath: string;
	oldPath: string | null;
	newPath: string | null;
	oldSize: number | null;
	newSize: number | null;
}

export interface TaskDiffResponse {
	mode: TaskDiffMode;
	compareRef: string | null;
	compareLabel: string;
	fallbackReason: TaskDiffFallbackReason | null;
	summary: TaskDiffSummary;
	files: TaskDiffFile[];
	skippedFiles: TaskDiffSkippedFile[];
}

export interface PRInfo {
	number: number;
	url: string;
	headRefName: string;
}

/**
 * CI/checks rollup for a task's open PR, collapsed from GitHub's
 * `statusCheckRollup`. `null` = no PR / no checks reported yet.
 */
export type PRCIStatus = "success" | "failure" | "pending";

/**
 * PR review outcome, mapped from GitHub's `reviewDecision` (plus a derived
 * `commented` when reviews exist without an approve/changes decision).
 * `null` = no review activity yet.
 */
export type PRReviewState = "approved" | "changes_requested" | "commented";

/**
 * Per-task PR badge data shown on the Kanban card: PR number/url (from
 * `getProjectPRs`) plus optional CI/review state (from the background PR
 * poller's `taskPrStatus` push). `ciStatus`/`reviewState` are absent until the
 * poller reports them.
 */
export interface TaskPRBadgeInfo {
	number: number;
	url: string;
	ciStatus?: PRCIStatus | null;
	reviewState?: PRReviewState | null;
}

// ---- Listening ports ----

export interface PortInfo {
	port: number;
	pid: number;
	processName: string; // "node", "bun", "python3"
}

// ---- Exposed ports (Cloudflare tunnels for dev servers) ----

export type ExposedPortKind = "quick" | "shared";

/**
 * A dev-server port (or group of ports) being shared publicly through a
 * Cloudflare quick-tunnel. `kind: "quick"` is one cloudflared per port
 * â its own random `*.trycloudflare.com` URL. `kind: "shared"` is one
 * cloudflared shared between multiple ports of the same task â those ports
 * are reached via `<url>/p/<port>/...` on the headless server which proxies
 * the request to localhost:<port>. Shared mode lets a frontend and backend
 * talk to each other via relative URLs (no CORS, no hardcoded URLs).
 *
 * State is runtime-only â never persists to tasks.json. Tunnels are torn
 * down on explicit stop, after two consecutive port-scan misses (~20 s),
 * on task removal, and on app shutdown.
 */
export interface ExposedPort {
	taskId: string;
	kind: ExposedPortKind;
	/**
	 * For `quick`, exactly one element â the dev-server port. For `shared`,
	 * the full set of ports reachable through this tunnel.
	 */
	ports: number[];
	url: string | null;
	state: "starting" | "connected" | "failed";
	startedAt: number;
}

// ---- Resource usage ----

export interface ResourceUsage {
	cpu: number;
	rss: number;
}

// ---- tmux layout (dev3 ui state) ----

export interface TmuxWindowInfo {
	index: number;
	name: string;
	active: boolean;
	panes: number;
	/**
	 * Whether this window is currently zoomed to a single pane. When true, only
	 * the active pane is visible on screen even though `panes` still reports the
	 * real split — the close-pane picker uses this to overlay a single hit-box
	 * instead of the (invisible) multi-pane geometry.
	 */
	zoomed: boolean;
}

export interface TmuxPaneInfo {
	windowIndex: number;
	paneId: string;
	active: boolean;
	/** Geometry in character cells, relative to the window. */
	left: number;
	top: number;
	width: number;
	height: number;
	command: string;
	title: string;
}

export interface TmuxLayout {
	sessionName: string;
	exists: boolean;
	windows: TmuxWindowInfo[];
	panes: TmuxPaneInfo[];
	/**
	 * Rows the tmux status bar reserves from the terminal. Pane geometry above is
	 * the WINDOW (pane area) and excludes these rows, but the rendered canvas
	 * includes them — the close-pane picker adds this back so its overlay lines up
	 * vertically. Omitted/0 when the status bar is off or couldn't be measured.
	 */
	statusLines?: number;
	/** True when the status bar sits on top (so the pane area starts `statusLines` rows down). */
	statusAtTop?: boolean;
}

// ---- Task dev server ----

export interface DevServerStatus {
	projectId: string;
	taskId: string;
	running: boolean;
	hasDevScript: boolean;
	worktreePath: string | null;
	tmuxSocket: string;
	taskSessionName: string;
	devSessionName: string;
	viewerPaneId: string | null;
	panePids: number[];
	assignedPorts: number[];
	ports: PortInfo[];
	/**
	 * Listening ports bound by processes inside the dev-server tmux session's
	 * own process tree (empty when stopped). Unlike `ports` (whole task session,
	 * cached), this is a live scan scoped to the dev server — a non-empty list
	 * is the readiness signal `dev3 dev-server start --wait` polls for.
	 */
	devPorts: PortInfo[];
	/**
	 * Assigned pool ports currently bound by a process OUTSIDE the dev-server
	 * tree — a conflicting owner that will make the devScript crash-loop on
	 * bind. Surfaced so a squatted port is visible at start/status instead of
	 * only as a downstream 502.
	 */
	portConflicts: PortInfo[];
	resourceUsage?: ResourceUsage;
}

// ---- Remote (headless `dev3 remote`) lifecycle ----

/**
 * On-disk record of a running `dev3 remote` headless server, written to
 * `~/.dev3.0/remote/state.json` by the server on startup and removed on
 * graceful shutdown. Lets a SEPARATE `dev3 remote status/stop/url` process
 * (e.g. a fresh SSH session) discover, query, and stop a backgrounded server
 * without scraping the banner. This is an ADDITIVE path — older app versions
 * never read it, so it does not touch the frozen `~/.dev3.0/` layout invariants.
 */
export interface RemoteServerState {
	/** PID of the headless `dev3-server` process (liveness-checked via signal 0). */
	pid: number;
	/** TCP port the remote-access HTTP/WS server bound to. */
	port: number;
	/** Unix CLI socket path this server is listening on (for `url`/`status`). */
	socketPath: string;
	/** Whether a Cloudflare tunnel was requested for this run. */
	tunnelRequested: boolean;
	/** Static access code if `--static-code` was used, else null. */
	staticCode: string | null;
	/** Log file the detached server's stdout/stderr was redirected to (null if foreground). */
	logFile: string | null;
	/** ISO timestamp of when the server started. */
	startedAt: string;
	/** dev3 build version that wrote this record. */
	version: string;
}

/**
 * One IPv4 address the headless server is reachable at, for the Remote Access
 * modal's interface picker. `internal: true` marks loopback (127.0.0.1).
 */
export interface RemoteNetInterface {
	/** Interface name (e.g. "en0", "utun3") or "loopback" for 127.0.0.1. */
	name: string;
	/** The IPv4 address. */
	address: string;
	/** True for loopback / same-machine addresses. */
	internal: boolean;
}

/**
 * Fresh access info for a running remote server, returned by the `remote.accessUrl`
 * CLI-socket method. The URL embeds a one-time QR token minted in the SERVER
 * process (where the JWT secret lives), so a detached `dev3 remote url` can print
 * a scannable URL it could never mint itself.
 */
export interface RemoteAccessInfo {
	/** Full access URL with a fresh `?token=` (QR or static code). */
	url: string;
	/** Public Cloudflare tunnel URL, or null if no tunnel is connected. */
	tunnelUrl: string | null;
	/** TCP port the server is bound to. */
	port: number;
	/** Static access code if in `--static-code` mode, else null. */
	staticCode: string | null;
}

// ---- Tmux sessions ----

export interface TmuxSessionInfo {
	name: string;
	cwd: string;
	createdAt: number;
	windowCount: number;
	isCleanup: boolean;
	isProjectTerminal?: boolean;
	projectName?: string;
	taskTitle?: string;
	taskId?: string;
	projectId?: string;
	ports?: PortInfo[];
	resourceUsage?: ResourceUsage;
}

// ---- System requirements ----

export interface RequirementCheckResult {
	id: string;
	name: string;
	installed: boolean;
	installHint: string; // i18n key
	installCommand: string;
	resolvedPath?: string; // full path to the binary (if found)
	brewInstallable: boolean;
	customPathError?: boolean; // true if custom path was set but file doesn't exist
	optional?: boolean; // optional requirements don't block the app
}

// ---- Agent availability ----

export interface AgentCheckResult {
	agentId: string;
	name: string;
	baseCommand: string;
	installed: boolean;
	resolvedPath?: string;
	installCommand?: string;
	installUrl?: string;
	customPathError?: boolean;
}

// ---- CLI socket protocol ----

export interface CliRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface CliResponse {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}


// ---- Folder picker ----

export interface FolderEntry {
	name: string;
	path: string;
	isDir: boolean;
}

export interface FolderListing {
	path: string;
	parent: string | null;
	home: string;
	entries: FolderEntry[];
	/** Present when the requested path could not be read. `entries` is empty then. */
	error?: string;
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


// ---- Productivity stats ----

/**
 * One per-task record returned by `getProductivityStats`. The renderer buckets
 * and aggregates these client-side per the selected time range (so range
 * switching needs no round-trip). All timestamps are ISO 8601.
 */
export interface ProductivityStatEvent {
	taskId: string;
	projectId: string;
	projectName: string;
	projectKind: "git" | "virtual";
	title: string;
	status: TaskStatus;
	/** Task creation time. */
	createdAt: string;
	/**
	 * Time the task last changed status. For terminal statuses (completed /
	 * cancelled) this equals the completion/cancellation time — the field the
	 * dashboard uses to bucket "tasks completed over time". Null when unknown.
	 */
	movedAt: string | null;
	insertions: number;
	deletions: number;
	files: number;
	/** True when LOC was computed live from an active worktree (not the captured snapshot). */
	liveStats: boolean;
	agentId: string | null;
	groupId: string | null;
	variantIndex: number | null;
}

export interface ProductivityStats {
	events: ProductivityStatEvent[];
	/** ISO time the stats were generated (server clock). */
	generatedAt: string;
}

// ---- Agent usage (tokens & cost) ----

/** Which coding agent a usage row was parsed from. */
export type AgentUsageSource = "claude" | "codex";

/**
 * One agent's token usage for a single local calendar day, as reconstructed from
 * on-disk agent state (Claude transcripts / Codex rollouts). No API calls.
 * The renderer buckets these client-side per the selected dashboard range.
 */
export interface AgentUsageDay {
	/** Local calendar day, YYYY-MM-DD. */
	date: string;
	/** Local-midnight epoch ms for `date` — lets the renderer filter by the dashboard period window. */
	startMs: number;
	source: AgentUsageSource;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	/** API-equivalent cost in USD (what per-token API billing *would* cost; subscription-subsidised in reality). */
	costUsd: number;
	/** True if every model seen on this day had a known price; false means costUsd under-counts. */
	fullyPriced: boolean;
}

export interface AgentUsageReport {
	days: AgentUsageDay[];
	/** ISO time the report was generated (server clock). */
	generatedAt: string;
	/** True if some parsed usage referenced a model with no known price (costUsd is a lower bound). */
	hasUnpricedModels: boolean;
}

// ---- RPC schema ----

export type AppRPCSchema = {
	bun: RPCSchema<{
		requests: {
			getProjects: {
				params: void;
				response: Project[];
			};
			reorderProjects: {
				params: { projectIds: string[] };
				response: Project[];
			};
			listDirectory: {
				params: { path?: string | null; includeFiles?: boolean; showHidden?: boolean };
				response: FolderListing;
			};
			listAgentSkills: {
				params: { projectPath?: string | null };
				response: AgentSkillInfo[];
			};
			createCustomColumn: {
				params: { projectId: string; name: string; color?: string };
				response: CustomColumn;
			};
			updateCustomColumn: {
				params: { projectId: string; columnId: string; name?: string; color?: string; llmInstruction?: string; agentConfig?: ColumnAgentConfig | null };
				response: CustomColumn;
			};
			renameBuiltinColumn: {
				params: { projectId: string; status: TaskStatus; name: string | null };
				response: Project;
			};
			deleteCustomColumn: {
				params: { projectId: string; columnId: string };
				response: void;
			};
			moveTaskToCustomColumn: {
				params: { taskId: string; projectId: string; customColumnId: string | null };
				response: Task;
			};
			reorderColumns: {
				params: { projectId: string; columnOrder: string[] };
				response: Project;
			};
			addProject: {
				params: { path: string; name: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			cloneAndAddProject: {
				params: { url: string; baseDir: string; repoName?: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			createDirectory: {
				params: { parentPath: string; name: string };
				response: { ok: true; path: string } | { ok: false; error: string };
			};
			initAndAddProject: {
				params: { path: string; name: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			/** Create a virtual "Operations" board (no git repo). Stored in virtual-projects.json. */
			addVirtualProject: {
				params: { name: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			removeProject: {
				params: { projectId: string };
				response: void;
			};
			detectClonePaths: {
				params: { projectId: string };
				response: string[];
			};
			/** Resolve a project's settings from a worktree path (merges .dev3/ configs). */
			getResolvedProject: {
				params: { projectId: string; worktreePath: string };
				response: Project;
			};
			/** Load raw contents of .dev3/config.json and .dev3/config.local.json + app-level config. */
			getProjectConfigs: {
				params: { projectId: string; worktreePath?: string };
				response: { repo: Dev3RepoConfig; local: Dev3RepoConfig };
			};
			/** Check which .dev3/ config files exist in the project root. */
			getProjectConfigFiles: {
				params: { projectId: string };
				response: { hasRepoConfig: boolean; hasLocalConfig: boolean };
			};
			/** Update project settings in projects.json (scripts, clone paths, AI Review, etc.). */
			updateProjectSettings: {
				params: { projectId: string } & ProjectSettingsUpdate;
				response: Project;
			};
			/** Save to .dev3/config.json. When autoCommit is true, commits the change in the worktree. */
			saveRepoConfig: {
				params: { projectId: string; worktreePath?: string; autoCommit?: boolean } & Dev3RepoConfig;
				response: void;
			};
			/** Save to .dev3/config.local.json. */
			saveLocalConfig: {
				params: { projectId: string; worktreePath?: string } & Dev3RepoConfig;
				response: void;
			};
			/** Per-field source provenance (repo or local). */
			getRepoConfigSources: {
				params: { projectId: string; worktreePath?: string };
				response: ConfigSourceEntry[];
			};
			getGlobalSettings: {
				params: void;
				response: GlobalSettings;
			};
			getGitHubCliStatus: {
				params: void;
				response: GitHubCliStatus;
			};
			saveGlobalSettings: {
				params: GlobalSettings;
				response: void;
			};
			/** Symlink the bundled dev3 CLI to ~/.dev3.0/bin/dev3 (for dev/debug). */
			installDev3Cli: {
				params: void;
				response: { installedFrom: string };
			};
			getAgents: {
				params: void;
				response: CodingAgent[];
			};
			saveAgents: {
				params: { agents: CodingAgent[] };
				response: void;
			};
			getTasks: {
				params: { projectId: string };
				response: Task[];
			};
			getAllProjectTasks: {
				params: void;
				response: { projectId: string; tasks: Task[] }[];
			};
			getProductivityStats: {
				params: void;
				response: ProductivityStats;
			};
			getAgentUsage: {
				params: void;
				response: AgentUsageReport;
			};
			getAgentRateLimits: {
				params: void;
				response: AgentRateLimitsReport;
			};
			searchConversations: {
				params: { projectId: string; query: string; currentTaskId?: string | null; limit?: number; allStatuses?: boolean };
				response: ConversationMatch[];
			};
			createTask: {
				params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string; scratch?: boolean; opsWorkDir?: string };
				response: Task;
			};
			moveTask: {
				// `clientPlayedSound`: the UI already played the completion/cancel sound
				// optimistically in the initiating renderer, so the backend must NOT
				// also push `taskSound` (that push fans out to every connected renderer
				// — a desktop window AND a remote browser on the same machine — and
				// would play a second time). Unset for CLI / branch-merge / agent
				// approval, where no renderer played locally and the push is the sound.
				params: { taskId: string; projectId: string; newStatus: TaskStatus; force?: boolean; clientPlayedSound?: boolean };
				response: Task;
			};
			cancelTaskPreparation: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			reorderTask: {
				params: { taskId: string; projectId: string; targetIndex: number };
				response: Task[];
			};
			deleteTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			editTask: {
				params: { taskId: string; projectId: string; description: string };
				response: Task;
			};
			renameTask: {
				params: { taskId: string; projectId: string; customTitle: string | null };
				response: Task;
			};
			setUserOverview: {
				params: { taskId: string; projectId: string; userOverview: string };
				response: Task;
			};
			clearUserOverview: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			spawnVariants: {
				params: {
					taskId: string;
					projectId: string;
					targetStatus: TaskStatus;
					variants: Array<{ agentId: string | null; configId: string | null }>;
				};
				response: Task[];
			};
			addAttempts: {
				params: {
					taskId: string;
					projectId: string;
					variants: Array<{ agentId: string | null; configId: string | null }>;
				};
				response: Task[];
			};
			prepareMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean };
				response: { shouldPrompt: boolean; fingerprint: string | null };
			};
			dismissMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint: string | null };
				response: Task;
			};
			getPtyUrl: {
				params: { taskId: string; resume?: boolean };
				response: { url: string } | { recoverable: true; sessionState: TaskSessionState };
			};
			resumeTask: {
				params: { taskId: string };
				response: string;
			};
			restartTask: {
				params: { taskId: string };
				response: string;
			};
			getProjectPtyUrl: {
				params: { projectId: string };
				response: string;
			};
			destroyProjectTerminal: {
				params: { projectId: string };
				response: void;
			};
			/** Spawn a fresh scratch op in the built-in Operations board, launched with the default agent. */
			openQuickShell: {
				params: {};
				response: Task;
			};
			runDevServer: {
				params: { taskId: string; projectId: string };
				response: DevServerStatus;
			};
			checkDevServer: {
				params: { taskId: string; projectId: string };
				response: { running: boolean };
			};
			stopDevServer: {
				params: { taskId: string; projectId: string };
				response: DevServerStatus;
			};
			restartDevServer: {
				params: { taskId: string; projectId: string };
				response: DevServerStatus;
			};
			getDevServerStatus: {
				params: { taskId: string; projectId: string };
				response: DevServerStatus;
			};
			parseRunnableScripts: {
				params: { taskId: string; projectId: string };
				response: WorktreeScripts;
			};
			runScript: {
				params: {
					taskId: string;
					projectId: string;
					scriptName: string;
					placement: ScriptPlacement;
					source: ScriptSource;
					runner?: ScriptRunner;
				};
				response: { ok: true };
			};
			openFileBrowser: {
				params: { taskId: string; projectId: string };
				response: { notInstalled: true; installCommand: string; linuxHint?: boolean } | void;
			};
			getBranchStatus: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: BranchStatus;
			};
			getTaskDiff: {
				params: { taskId: string; projectId: string; mode: TaskDiffMode; compareRef?: string; compareLabel?: string };
				response: TaskDiffResponse;
			};
			rebaseTask: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: void;
			};
			rebaseTaskViaAgent: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: { handedOff: boolean };
			};
			mergeTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			pushTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			createPullRequest: {
				params: { taskId: string; projectId: string; autoMerge?: boolean };
				response: void;
			};
			openPullRequest: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			getTerminalPreview: {
				params: { taskId: string };
				response: string | null;
			};
			checkWorktreeExists: {
				params: { path: string };
				response: boolean;
			};
			checkForUpdate: {
				params: void;
				response: { updateAvailable: boolean; version: string; error?: string };
			};
			downloadUpdate: {
				params: void;
				response: { ok: boolean; error?: string };
			};
			applyUpdate: {
				params: void;
				response: void;
			};
			saveLastRoute: {
				params: { route: string };
				response: void;
			};
			getLastRoute: {
				params: void;
				response: { route: string | null };
			};
			getAppVersion: {
				params: void;
				response: { version: string; channel: string; buildChannel: string };
			};
			checkSystemRequirements: {
				params: void;
				response: RequirementCheckResult[];
			};
			checkGhAvailable: {
				params: void;
				response: { available: boolean; notInstalled: boolean };
			};
			setCustomBinaryPath: {
				params: { requirementId: string; path: string };
				response: void;
			};
			checkAgentAvailability: {
				params: void;
				response: AgentCheckResult[];
			};
			setAgentBinaryPath: {
				params: { agentId: string; path: string };
				response: void;
			};
			getChangelogs: {
				params: void;
				response: ChangelogEntry[];
			};
			quitApp: {
				params: { dontShowAgain?: boolean } | void;
				response: void;
			};
			requestQuit: {
				params: void;
				response: void;
			};
			consumePendingQuitDialog: {
				params: void;
				response: boolean;
			};
			consumePendingNotificationNav: {
				params: void;
				response: { taskId: string; projectId: string } | null;
			};
			openNewWindow: {
				params: void;
				response: void;
			};
			hideApp: {
				params: void;
				response: void;
			};
			getTaskPorts: {
				params: { taskId: string };
				response: PortInfo[];
			};
			getPortAllocations: {
				params: { taskId: string };
				response: number[];
			};
			listTmuxSessions: {
				params: void;
				response: TmuxSessionInfo[];
			};
			killTmuxSession: {
				params: { sessionName: string };
				response: void;
			};
			createLabel: {
				params: { projectId: string; name: string; color?: string };
				response: Label;
			};
			updateLabel: {
				params: { projectId: string; labelId: string; name?: string; color?: string };
				response: Label;
			};
			deleteLabel: {
				params: { projectId: string; labelId: string };
				response: void;
			};
			setTaskLabels: {
				params: { taskId: string; projectId: string; labelIds: string[] };
				response: Task;
			};
			toggleTaskWatch: {
				params: { taskId: string; projectId: string; watched: boolean };
				response: Task;
			};
			addTaskNote: {
				params: { taskId: string; projectId: string; content: string; source?: NoteSource };
				response: Task;
			};
			updateTaskNote: {
				params: { taskId: string; projectId: string; noteId: string; content: string };
				response: Task;
			};
			deleteTaskNote: {
				params: { taskId: string; projectId: string; noteId: string };
				response: Task;
			};
			tmuxAction: {
				params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV"; force?: boolean };
				response: void;
			};
			tmuxPaneCount: {
				params: { taskId: string };
				response: { count: number };
			};
			tmuxKillPane: {
				params: { taskId: string; paneId: string; force?: boolean };
				response: { killed: boolean };
			};
			tmuxPaneNavigate: {
				params: { taskId: string; step?: "next" | "prev"; index?: number; paneId?: string; zoom?: boolean };
				response: { count: number; activeIndex: number; zoomed: boolean; labels: string[] };
			};
			tmuxLayout: {
				params: { taskId: string };
				response: TmuxLayout;
			};
			tmuxWindowNavigate: {
				params: { taskId: string; step?: "next" | "prev"; index?: number };
				response: { count: number; activeIndex: number; labels: string[] };
			};
			tmuxAltClickMoveCursor: {
				params: { taskId: string; col: number; row: number };
				response: { moved: boolean };
			};
			exitCopyModeAllPanes: {
				params: { taskId: string };
				response: { panesExited: number };
			};
			copyTerminalSelection: {
				params: { taskId: string; text: string; mouseTracking: boolean };
				response: { ok: boolean; tool: string | null };
			};
			spawnAgentInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null };
				response: void;
			};
			spawnBugHuntersInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; count: number };
				response: { spawned: number };
			};
			pasteClipboardImage: {
				params: { projectId: string };
				response: { path: string } | null;
			};
			readImageBase64: {
				params: { path: string };
				response: { dataUrl: string } | null;
			};
			openImageFile: {
				params: { path: string };
				response: void;
			};
			openFolder: {
				params: { path: string };
				response: void;
			};
			openInApp: {
				params: { appName: string; path: string };
				response: void;
			};
			/**
			 * Open a specific macOS System Settings pane. On non-darwin platforms
			 * this is a no-op and returns `{ ok: false }`. Used by the stuck-
			 * preparation modal to deep-link to Full Disk Access.
			 */
			openSystemSettings: {
				params: { pane: "fullDiskAccess" };
				response: { ok: boolean };
			};
			/**
			 * Resolved threshold (ms) for the stuck-preparation popover.
			 * Defaults to {@link STUCK_PREPARATION_FETCH_THRESHOLD_MS} and can be
			 * overridden by setting `DEV3_STUCK_PREP_THRESHOLD_SEC` when launching
			 * the app. Read once by the renderer on startup.
			 */
			getStuckPreparationThresholdMs: {
				params: void;
				response: { ms: number };
			};
			getAvailableApps: {
				params: void;
				response: ExternalApp[];
			};
			logRendererError: {
				params: { description: string; source: "error" | "unhandledrejection" };
				response: void;
			};
			// TEMP DIAGNOSTIC: remove with terminal copy investigation cleanup.
			logRendererEvent: {
				params: {
					level: RendererLogLevel;
					tag: string;
					message: string;
					extra?: Record<string, string | number | boolean | null>;
				};
				response: void;
			};
			listBranches: {
				params: { projectId: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
			fetchBranches: {
				params: { projectId: string; forkRef?: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
			getProjectCurrentBranch: {
				params: { projectId: string };
				response: { branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number };
			};
			pullProjectMain: {
				params: { projectId: string };
				response: { ok: boolean; branch: string | null; output: string; error: string };
			};
			getTipState: {
				params: void;
				response: TipState;
			};
			updateTipState: {
				params: Partial<TipState>;
				response: TipState;
			};
			resetTipState: {
				params: void;
				response: TipState;
			};
			getProjectPRs: {
				params: { projectId: string };
				response: PRInfo[];
			};
			setTmuxTheme: {
				params: { theme: "dark" | "light"; preference?: "dark" | "light" | "system" };
				response: void;
			};
			/**
			 * Pushed by the renderer whenever the current route changes; the bun
			 * side uses it to rebuild the native menu so context-aware items
			 * (task / project / terminal) render disabled when irrelevant.
			 */
			updateMenuContext: {
				params: { hasTask: boolean; hasProject: boolean; hasTerminal: boolean };
				response: void;
			};
			checkCaffeinateAvailable: {
				params: void;
				response: { available: boolean };
			};
			getPreventSleepState: {
				params: void;
				response: { enabled: boolean; available: boolean; forcedByRemote: boolean };
			};
			setPreventSleep: {
				params: { enabled: boolean };
				response: { enabled: boolean };
			};
			uploadFileBase64: {
				params: { projectId: string; base64: string; filename?: string; mimeType?: string };
				response: { path: string } | null;
			};
			uploadImageBase64: {
				params: { projectId: string; base64: string; filename?: string; mimeType?: string };
				response: { path: string } | null;
			};
			getRemoteAccessQR: {
				params: { tunnel?: boolean; host?: string };
				response: { qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean; interfaces: RemoteNetInterface[]; selectedHost: string };
			};
			checkCloudflared: {
				params: void;
				response: { installed: boolean };
			};
			startTunnel: {
				params: void;
				response: { url: string | null; state: string };
			};
			stopTunnel: {
				params: void;
				response: void;
			};
			exposePort: {
				params: { taskId: string; port: number };
				response: ExposedPort;
			};
			exposePortsShared: {
				params: { taskId: string; ports: number[] };
				response: ExposedPort;
			};
			unexposePort: {
				params: { taskId: string; port: number };
				response: void;
			};
			unexposeShared: {
				params: { taskId: string };
				response: void;
			};
			listExposedPorts: {
				params: { taskId?: string };
				response: ExposedPort[];
			};
			getSshForwardCommand: {
				params: { ports: number[] };
				response: { command: string; hostGuess: string | null };
			};
			/**
			 * Renderer reports its window focus state so the backend can tell whether
			 * the app is in the foreground. Used to suppress notification click-to-open
			 * arming while the user is already looking at the app.
			 */
			setWindowForeground: {
				params: { focused: boolean };
				response: void;
			};
			/**
			 * Renderer reports which project board / task it is currently viewing.
			 * Background git pollers use this to poll the active board at full
			 * cadence while throttling every off-screen project heavily.
			 */
			setActiveContext: {
				params: { projectId: string | null; taskId: string | null };
				response: void;
			};
			/**
			 * Renderer answers an `agentCompletionRequested` dialog. Approval makes
			 * the blocked CLI request execute the move to `completed`; decline just
			 * releases it with a refusal.
			 */
			respondToAgentCompletionRequest: {
				params: { requestId: string; approved: boolean };
				response: void;
			};
			/**
			 * Cheap liveness probe for the desktop RPC bridge watchdog. The renderer
			 * pings this on wake/focus with a short timeout; a missed ping means the
			 * Electrobun localhost socket has jammed and the bridge needs recovery.
			 */
			ping: {
				params: void;
				response: { ok: true; t: number };
			};
			listAutomations: {
				params: { projectId: string };
				response: Automation[];
			};
			createAutomation: {
				params: { projectId: string } & AutomationDraft;
				response: Automation;
			};
			updateAutomation: {
				params: { projectId: string; automationId: string } & Partial<AutomationDraft>;
				response: Automation;
			};
			deleteAutomation: {
				params: { projectId: string; automationId: string };
				response: void;
			};
			/** Fire an automation immediately (does not consume/advance the schedule). */
			runAutomationNow: {
				params: { projectId: string; automationId: string };
				response: { taskId: string };
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			projectUpdated: { project: Project };
			taskSound: { status: "completed" | "cancelled"; taskId: string };
			ptyDied: { taskId: string };
			projectPtyDied: { projectId: string };
			terminalBell: { taskId: string };
			gitOpCompleted: { taskId: string; projectId: string; operation: string; ok: boolean };
			updateAvailable: { version: string };
			branchMerged: { taskId: string; projectId: string; taskTitle: string; branchName: string; fingerprint: string | null };
			/**
			 * Emitted when an agent runs `dev3 task move --status completed`. The CLI
			 * blocks on the user's decision; the renderer shows an AI-styled confirm
			 * dialog and answers via `respondToAgentCompletionRequest`.
			 */
			agentCompletionRequested: { requestId: string; taskId: string; projectId: string; taskTitle: string; taskOverview?: string };
			portsUpdated: { taskId: string; ports: PortInfo[] };
			exposedPortsChanged: { taskId: string; ports: ExposedPort[] };
			resourceUsageUpdated: { taskId: string; usage: ResourceUsage };
			/**
			 * Fresh agent rate-limit data (Claude statusLine dump / Codex rollouts).
			 * Pushed by the rate-limit monitor whenever the parsed windows change.
			 */
			agentRateLimitsUpdated: AgentRateLimitsReport;
			updateDownloadProgress: { status: string; progress?: number };
			/** Emitted when a column-agent launch fails (custom columns have no automatic fallback). */
			columnAgentFailed: { taskId: string; projectId: string; columnName: string; error: string };
			/**
			 * Emitted when background worktree/PTY preparation for a task fails (e.g.
			 * empty repo, missing base branch). The task is reverted to todo so it is
			 * recoverable; the renderer surfaces this as a toast instead of leaving a
			 * misleading "[session ended]" terminal.
			 */
			taskPreparationFailed: { taskId: string; projectId: string; taskTitle: string; error: string };
			/**
			 * Emitted when the main window gains focus shortly after a watched-task notification fired.
			 * The renderer navigates to the referenced task â implements click-to-open for native notifications.
			 */
			openTaskFromNotification: { taskId: string; projectId: string };
			/**
			 * CLI-initiated in-app toast (`dev3 notify`). When `taskId`/`projectId`
			 * are present the toast is clickable and navigates to that task.
			 */
			cliToast: {
				taskId: string | null;
				projectId: string | null;
				message: string;
				level: "info" | "success" | "error";
				/** Source-task context for the toast header (present when a task was resolved). */
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * CLI-initiated attention signal (`dev3 attention`). Lights the red bell
			 * badge on the task card with a hoverable `reason`, same surface the
			 * terminal bell uses.
			 */
			cliAttention: { taskId: string; reason: string };
			/**
			 * Browser Web Notification request. Mirrors a native OS notification
			 * (`dev3 notify --desktop`, watched-task status/event banners) for clients
			 * running in remote/browser mode, where `Utils.showNotification` is a no-op.
			 * The desktop WKWebView ignores it (native already fired); browsers show a
			 * `new Notification(...)`, or fall back to an in-app toast when the
			 * Notification API is unavailable (insecure LAN context) or not granted.
			 */
			webNotification: {
				taskId: string;
				projectId: string;
				/** Notification heading, e.g. "#804 Fix bug". */
				title: string;
				/** Notification body, e.g. a message or "In Progress → Review". */
				body: string;
				/** Toast-fallback variant when the Notification API can't be used. */
				level: "info" | "success" | "error";
				/** Source-task context for the fallback toast header. */
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * CI/checks + PR-review state for a task's open PR, emitted by the
			 * background PR poller (`checkOpenPRsForPromotion`). Drives the CI and
			 * review badges on the task card. Passive status â NOT gated by Focus
			 * Mode (only the bell/notification raised alongside it is).
			 */
			taskPrStatus: {
				projectId: string;
				taskId: string;
				prNumber: number | null;
				prUrl: string | null;
				ciStatus: PRCIStatus | null;
				reviewState: PRReviewState | null;
			};
			/** An automation changed (CRUD, a run fired, nextRunAt advanced) — refresh the Automations panel. */
			automationsUpdated: { projectId: string };
			/**
			 * Occurrences were missed while the app was offline (detected at scheduler
			 * startup). Surfaced as a toast — missed runs are never silently skipped.
			 */
			automationRunsMissed: { projectId: string; automationId: string; automationName: string; missedCount: number; caughtUp: boolean };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			openCreateTaskModal: {};
			openAddProjectModal: {};
			navigateToSettings: {};
			navigateToGaugeDemo: {};
			navigateToViewportLab: {};
			terminalSoftReset: {};
			terminalHardReset: {};
			zoomIn: {};
			zoomOut: {};
			zoomReset: {};
			osc52Clipboard: { taskId: string; text: string; len: number };
			qrTokenConsumed: {};
			showRemoteAccessQR: { qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean };
			/**
			 * Universal menu-action dispatch. The bun side fires this whenever the
			 * native menu emits an `application-menu-clicked` event whose action is
			 * routed to the renderer (most of them are). The renderer's `menuRouter`
			 * picks it up and dispatches into the relevant flow (modal, navigation,
			 * RPC call, state mutation) based on its `current` view/task/project.
			 *
			 * Bun-side side effects (open external URL, dialog, display-popup) do
			 * not go through this channel â they execute in `src/bun/index.ts`.
			 */
			menuAction: { action: string };
			/**
			 * Ask the renderer to show the quit-confirmation dialog. Fired from the
			 * bun `before-quit` gate when a quit was requested (Cmd+Q, menu Quit, or
			 * closing the last window) and the user hasn't opted out. The actual quit
			 * only happens after the renderer confirms via `quitApp`.
			 */
			showQuitDialog: {};
			/** Open the in-app About modal (replaces the native About message box). */
			showAbout: { version: string };
			/**
			 * Result of a manual "Check for Updates" menu action, surfaced as a toast.
			 * `available` updates flow through `updateAvailable` instead (header plaque).
			 */
			updateCheckOutcome: { status: "none" | "error"; version?: string; detail?: string };
		};
	}>;
};
