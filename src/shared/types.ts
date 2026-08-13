import type { RPCSchema } from "electrobun/bun";
import type { ConversationMatch } from "./conversation-search-core";
import type { AgentRateLimitsReport } from "./rate-limits";
import type { AgentAccount, AgentAccountKind, AgentAccountsState, ClaudeSlotModels } from "./agent-accounts";
import type { TerminalBackendIdentity } from "./terminal-backend-identity";
import type { TaskPaneState, TaskPaneAction, TaskPaneBackendKind } from "./task-panes";
import type { DeepLinkNav } from "./deep-link";
import type { UpdateChannel } from "./update-channel";
import type { AgentPromptDelivery } from "./agent-prompt-delivery";

// ---- Changelog ----

export interface ChangelogEntry {
	date: string; // "2026-03-01"
	type: string; // "feature" | "fix" | "refactor" | "docs" | "chore"
	slug: string; // "system-requirements-check"
	title: string; // First sentence of content (truncated to ~120 chars) — collapsed teaser
	body?: string; // Full cleaned content, present only when it has more than the title (expandable)
	short?: string; // Optional ≤6-word title for the update popover (from a "Short:" line)
	suggestedBy?: string; // GitHub username without @ (e.g. "roiros")
	issueUrl?: string; // Full GitHub issue URL (e.g. "https://github.com/h0x91b/dev-3.0/issues/191")
	issueRef?: string; // Short issue ref (e.g. "#191")
}

/**
 * Compact "what's new" summary embedded in the release `update.json` and pushed
 * to the renderer with `updateAvailable`. Features-first: the update popover
 * shows the feature titles + a rollup count and links to the full Changelog
 * screen. Absent for cross-channel updates or pre-changelog `update.json`.
 */
export interface UpdateChangelog {
	features: string[]; // Short feature titles, newest first, already capped for display
	featureCount: number; // Total new features in the release window
	fixCount: number; // Total new fixes in the release window
}

/**
 * Result of the dev-only update-popover simulator (`previewUpdatePopover` RPC).
 * Runs the release-time release-window logic against the local `change-logs/`
 * dir + git tags so a developer can preview the next release's "what's new"
 * popover before shipping. Unavailable on production bundles (no change-logs
 * dir / not a git checkout).
 */
export interface UpdatePopoverPreview {
	available: boolean; // false when there is no change-logs dir or the app is not running from a git checkout
	reason?: string; // machine-readable why-unavailable code, when available === false
	changelog: UpdateChangelog | null; // exactly what the real popover would render
	diagnostics: {
		prevTag: string | null; // release tag the window is measured from (null → fallback / no tags)
		usedFallback: boolean; // git window empty → fell back to the newest-day batch
		windowFiles: string[]; // "<type>-<slug>" of each entry in the window
		totalEntries: number; // total parsed changelog entries (whole history)
		includesUncommitted: boolean; // window counts working-tree + untracked files, not just committed
		mergedPRs: number; // squash-merged PRs (commits with a "(#N)" subject) since prevTag
	};
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

/**
 * Rejection message every activation path produces for a draft task. The CLI
 * compares against it to translate the lifecycle rejection into its dedicated
 * exit code, so the string is a contract — not free-form log text.
 */
export const DRAFT_TASK_ACTIVATION_ERROR =
	"Task is a draft — finish its description and save it as a normal task before starting it.";

/**
 * Rejection message every column change on a hibernated task produces. Like
 * {@link DRAFT_TASK_ACTIVATION_ERROR} this string is a contract, not log text.
 */
export const HIBERNATED_TASK_MOVE_ERROR =
	"Task is hibernated — wake it from its terminal before moving it to another column.";

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

/** Light-theme column colours. Every one sits at the sRGB chroma ceiling for its
 *  lightness, and the hues are spaced (15° → 40° → 95° → 152° → 232° → 272° →
 *  318°) so that a column stays recognisable after the glow overlay keeps only a
 *  fraction of its chroma. `review-by-ai` is deliberately the neutral one.
 *
 *  These values are optimised for use as **glow, dot, and border identity** —
 *  NOT as text ink. For rendered text use STATUS_COLORS_LIGHT_INK instead. */
export const STATUS_COLORS_LIGHT: Record<TaskStatus, string> = {
	todo: "#0182b0",
	"in-progress": "#4b59ff",
	"user-questions": "#d04801",
	"review-by-ai": "#656971",
	"review-by-user": "#9e8401",
	"review-by-colleague": "#b702df",
	completed: "#04944b",
	cancelled: "#d20346",
};

/** Light-theme ink colours for column header badges/chips where the status
 *  colour is rendered as text. Verified to clear APCA |Lc| ≥ 60 on the
 *  composited glass column header surface; hues match STATUS_COLORS_LIGHT but
 *  are darkened where the standard value falls below the floor. */
export const STATUS_COLORS_LIGHT_INK: Record<TaskStatus, string> = {
	todo: "#01699e",           // darkened (standard: #0182b0, Lc ~57)
	"in-progress": "#4b59ff",  // passes as-is (Lc ~63)
	"user-questions": "#a63801", // darkened (standard: #d04801, Lc ~59)
	"review-by-ai": "#656971",   // passes as-is (Lc ~71)
	"review-by-user": "#736000", // darkened (standard: #9e8401, Lc ~50)
	"review-by-colleague": "#b702df", // passes as-is (Lc ~68)
	completed: "#06723a",      // darkened (standard: #04944b, Lc ~60)
	cancelled: "#d20346",      // passes as-is (Lc ~71)
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

// ---- Task priority ----

/**
 * Task importance, `P0` (highest) … `P4` (lowest). The numeric suffix IS the
 * rank (P0 = 0 = most important). Stored explicitly on every task; tasks created
 * before this field existed are stamped {@link DEFAULT_PRIORITY} by a load-time
 * in-place content migration (paths untouched — older app versions ignore the
 * unknown field). Priority belongs to the logical task, so every variant in a
 * group shares one value and the group never splits across sort bands.
 */
export type TaskPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** All priorities, highest → lowest. */
export const ALL_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];

/** Default priority for new tasks and for legacy tasks missing the field. */
export const DEFAULT_PRIORITY: TaskPriority = "P3";

/**
 * Sort rank of a priority: 0 (P0, highest) … 4 (P4, lowest). Missing/invalid
 * values fall back to the {@link DEFAULT_PRIORITY} rank so legacy tasks band as
 * P3. Lower rank sorts first (on top of a column).
 */
export function priorityRank(priority: TaskPriority | null | undefined): number {
	if (priority && /^P[0-4]$/.test(priority)) return Number(priority.slice(1));
	return Number(DEFAULT_PRIORITY.slice(1));
}

/**
 * Strict-band comparator: higher priority (lower rank) sorts first. This is the
 * TOPMOST sort key for a rendered column / sidebar group — all P0 above all P1,
 * etc. Within a band, callers apply their existing ordering rules unchanged.
 */
export function comparePriority(
	a: TaskPriority | null | undefined,
	b: TaskPriority | null | undefined,
): number {
	return priorityRank(a) - priorityRank(b);
}

/**
 * Rank offset added to a hibernated task so it sinks below every live P4 while
 * hibernated tasks stay internally ordered by their own priority. Any value
 * above the highest priority rank works; 10 keeps the two bands readable in a
 * debugger.
 */
export const HIBERNATED_SORT_OFFSET = 10;

/** The subset of a task the shared sort comparator reads. */
export type TaskSortFields = Pick<Task, "priority" | "hibernated">;

/**
 * Sort rank of a task: its {@link priorityRank}, plus {@link HIBERNATED_SORT_OFFSET}
 * when hibernated. Hibernation never writes `priority`, so waking a task returns
 * it to its rightful place in the queue.
 */
export function taskSortRank(task: TaskSortFields): number {
	return priorityRank(task.priority) + (task.hibernated ? HIBERNATED_SORT_OFFSET : 0);
}

/**
 * The one comparator every task list sorts by: strict priority bands with a
 * hibernated sink band underneath. Deliberately splits a variant group when one
 * variant is hibernated — the board should show honestly how many attempts are
 * still alive.
 */
export function compareTaskSortRank(a: TaskSortFields, b: TaskSortFields): number {
	return taskSortRank(a) - taskSortRank(b);
}

/**
 * Normalize free-form CLI input to a {@link TaskPriority}. Case-insensitive;
 * accepts `P0`–`P4` (any case) or a bare digit `0`–`4`. Returns `null` for
 * anything else so callers can reject it with a usage error.
 */
export function normalizePriority(input: string): TaskPriority | null {
	const m = /^\s*p?([0-4])\s*$/i.exec(input);
	return m ? (`P${m[1]}` as TaskPriority) : null;
}

// ---- Task relations ----

/** Relation kinds reserved for the task-linking foundation. */
export const TASK_RELATION_TYPES = ["blocked-by", "relates-to"] as const;

export type TaskRelationType = (typeof TASK_RELATION_TYPES)[number];

/** A typed link from a source task to a target task in the shared task store. */
export interface TaskRelation {
	type: TaskRelationType;
	taskId: string;
}

// ---- Column Agents ----

export interface ColumnAgentConfig {
	agentId: string; // e.g. "builtin-claude"
	configId: string; // e.g. "claude-auto-opus5-xhigh"
	prompt: string; // prompt sent to the agent
}

/** Agent + preset the "AI Review" column runs when a project never configured one. */
export const DEFAULT_REVIEW_AGENT_ID = "builtin-claude";
export const DEFAULT_REVIEW_CONFIG_ID = "claude-auto-opus5-xhigh";

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

/**
 * A column-agent launch failure the app recognises and can explain in the user's
 * own language. Carried as a stable code so the renderer never has to read the
 * English `error` string; anything unrecognised has no reason and falls back to
 * showing that string as diagnostics.
 */
export type ColumnAgentFailureReason = "terminal-not-running";

/**
 * Which column's agent this is, in a form the UI can name in the user's language.
 * A built-in column travels as its status (the renderer localizes it); only a
 * custom column, whose name the user typed, travels as a literal string.
 */
export type ColumnAgentIdentity =
	| { kind: "builtin"; status: TaskStatus }
	| { kind: "custom"; name: string };

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
	 * Which agent-native lifecycle hooks dev3 installs into the worktree.
	 * Undefined = auto-detect from `baseCommand`, which recognizes only the five
	 * literal CLI names — a wrapper script or an aliased command got no hooks at
	 * all, and therefore no automatic Kanban transitions, without saying so. This
	 * lets the user declare "that command is Claude Code"; `"none"` is the
	 * explicit opt-out. Hooks only: launch flags stay keyed by the command.
	 */
	hooksIntegration?: AgentHooksIntegration;
}

/** Hook family an agent's worktree gets: a CLI whose hooks dev3 knows, or none. */
export type AgentHooksIntegration = "claude" | "codex" | "none";

/**
 * Prefix used to invoke an installed skill from an agent prompt. Codex reserves
 * `/` for built-in commands, while the other supported agent CLIs use `/` for
 * skills. Unknown commands keep the broadly compatible slash default.
 */
export function skillInvocationPrefix(baseCommand: string): "$" | "/" {
	return (baseCommand.split("/").pop() ?? "") === "codex" ? "$" : "/";
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

export const DEFAULT_AGENTS: CodingAgent[] = [
	{
		id: "builtin-claude",
		name: "Claude",
		baseCommand: "claude",
		isDefault: true,
		installCommand: "brew install claude-code",
		installUrl: "https://docs.anthropic.com/en/docs/claude-code",
		configurations: [
			// --- Auto (Fable 5 first — flagship — then Opus 5/Opus 4.8/Sonnet 5 effort tiers, then Opus 4.7) ---
			{ id: "claude-auto-fable5-medium", name: "Auto (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-high", name: "Auto (Fable 5, High)", model: "claude-fable-5", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-fable5-xhigh", name: "Auto (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-medium", name: "Auto (Opus 5, Medium)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-high", name: "Auto (Opus 5, High)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "high", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus5-xhigh", name: "Auto (Opus 5, X-High)", model: "claude-opus-5[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-medium", name: "Auto (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus48-xhigh", name: "Auto (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-medium", name: "Auto (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "auto", effort: "medium", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-sonnet5-xhigh", name: "Auto (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "auto", effort: "xhigh", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-auto-opus47", name: "Auto (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "auto", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Bypass (same model order as Auto) ---
			{ id: "claude-bypass-fable5-medium", name: "Bypass (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-high", name: "Bypass (Fable 5, High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-fable5-xhigh", name: "Bypass (Fable 5, X-High)", model: "claude-fable-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-medium", name: "Bypass (Opus 5, Medium)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-high", name: "Bypass (Opus 5, High)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "high", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus5-xhigh", name: "Bypass (Opus 5, X-High)", model: "claude-opus-5[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-medium", name: "Bypass (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus48-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-medium", name: "Bypass (Sonnet 5, Medium)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "medium", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-sonnet5-xhigh", name: "Bypass (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "xhigh", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-bypass-opus47", name: "Bypass (Opus 4.7)", model: "claude-opus-4-7[1m]", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Default (Claude's normal permission mode). No hard bypass flag:
			//     the adapter injects --allow-dangerously-skip-permissions so bypass
			//     is available to toggle into (Shift+Tab) but is NOT on by default.
			//     Versions bumped so the old hard --dangerously-skip-permissions is
			//     dropped from already-stored copies (mergeConfig discards user
			//     additionalArgs when the preset version advances). ---
			{ id: "claude-default", name: "Default (Fable 5)", model: "claude-fable-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 9 },
			{ id: "claude-default-opus5", name: "Default (Opus 5)", model: "claude-opus-5[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-default-opus48", name: "Default (Opus 4.8)", model: "claude-opus-4-8[1m]", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			{ id: "claude-default-sonnet5", name: "Default (Sonnet 5)", model: "claude-sonnet-5", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 2 },
			// --- Plan ---
			// Plan mode: the allow-bypass flag is now injected by the claude adapter
			// for every session, so it is not repeated here (single source).
			{ id: "claude-plan", name: "Plan (Fable 5)", model: "claude-fable-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 9 },
			{ id: "claude-plan-opus5", name: "Plan (Opus 5)", model: "claude-opus-5[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-opus48", name: "Plan (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-plan-sonnet5", name: "Plan (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "plan", envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			// --- Accept Edits ---
			{ id: "claude-approvals", name: "Accept Edits (Fable 5)", model: "claude-fable-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 8 },
			{ id: "claude-approvals-opus5", name: "Accept Edits (Opus 5)", model: "claude-opus-5[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-opus48", name: "Accept Edits (Opus 4.8)", model: "claude-opus-4-8[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
			{ id: "claude-approvals-sonnet5", name: "Accept Edits (Sonnet 5)", model: "claude-sonnet-5", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], envVars: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, version: 1 },
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
		defaultConfigId: "claude-auto-opus5-medium",
	},
	{
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		isDefault: true,
		installCommand: "brew install codex",
		installUrl: "https://github.com/openai/codex",
		configurations: [
			// --- GPT-5.6 Luna (fast/affordable: practical default through max reasoning) ---
			{
				id: "codex-default",
				name: "GPT-5.6 Luna Bypass [X-High] — Default",
				model: "gpt-5.6-luna",
				groupLabel: "GPT-5.6 Luna",
				modeLabel: "Bypass [X-High] — Default",
				version: 9,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="xhigh"'],
			},
			...createCodexReasoningPresets(
				"gpt-5.6-luna",
				"GPT-5.6 Luna",
				"codex-5.6-luna",
				["max", "high", "medium"],
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
			// Sol-only workflows follow the popular Bypass and Standard modes.
			{
				id: "codex-plan",
				name: "GPT-5.6 Sol Plan [High]",
				model: "gpt-5.6-sol",
				groupLabel: "GPT-5.6 Sol",
				modeLabel: "Plan [High]",
				version: 7,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan-then-bypass",
				name: "GPT-5.6 Sol Plan → Bypass [High]",
				model: "gpt-5.6-sol",
				groupLabel: "GPT-5.6 Sol",
				modeLabel: "Plan → Bypass [High]",
				version: 7,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
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
		configurations: [
			{ id: "cursor-default", name: "Default (Opus 4.6)", model: "opus-4.6-thinking" },
			{ id: "cursor-plan", name: "Plan (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "plan" },
			{ id: "cursor-plan-then-bypass", name: "Plan then Bypass (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "plan", additionalArgs: ["--force"] },
			{ id: "cursor-yolo", name: "YOLO (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "bypassPermissions" },
			{ id: "cursor-gpt", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex-high" },
			{ id: "cursor-yolo-gpt", name: "YOLO GPT-5.3 Codex", model: "gpt-5.3-codex-high", permissionMode: "bypassPermissions" },
			{ id: "cursor-gemini", name: "Gemini 3.1 Pro", model: "gemini-3.1-pro" },
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

/**
 * What the GUI needs to render (and gate) a task's terminal-backend override:
 * the effective identity, whether the record carries it explicitly, and which
 * backend — if any — still owns a live session for the task.
 */
export interface TaskTerminalBackendInfo {
	backend: TerminalBackendIdentity;
	explicit: boolean;
	liveBackend: TerminalBackendIdentity | null;
}

/** Which terminal backends THIS machine's build can actually launch. */
export interface NativeTerminalAvailability {
	available: boolean;
	/**
	 * Whether tmux is a usable choice at all on the HOST platform. False on
	 * Windows, which ships no tmux runtime — the renderer must not offer it there,
	 * and browser-side platform sniffing would answer for the wrong machine.
	 */
	tmuxSupported: boolean;
	/** Provenance of the resolved host runtime; absent when unavailable. */
	origin?: string;
	/** Actionable reasons it could not be resolved; empty when available. */
	diagnostics: string[];
}

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	/**
	 * Secondary order inside a priority band, shared by the Kanban board and the
	 * Active Tasks sidebar. `oldest-first` floats the task whose status changed
	 * longest ago (the one most at risk of being forgotten); `newest-first` is the
	 * most-recently-used order. See sortTasks.ts.
	 */
	taskSortOrder: "oldest-first" | "newest-first";
	updateChannel: UpdateChannel;
	theme?: "dark" | "light" | "system";
	resolvedTheme?: "dark" | "light";
	/**
	 * The id PostHog buckets this install by, owned by bun so every renderer —
	 * desktop window and remote browser alike — reports the same one. Seeded once
	 * from the desktop renderer's own posthog-js id so existing installs keep
	 * their person instead of splitting into a second one.
	 */
	analyticsDistinctId?: string;
	cloneBaseDirectory?: string;
	customBinaryPaths?: Record<string, string>; // requirementId â custom binary path
	agentBinaryPaths?: Record<string, string>; // agentId â resolved binary path
	/**
	 * Beta: reorder right-to-left text (Hebrew, Arabic) for display in terminal
	 * panes. Display-only — copied text keeps its logical order, while mouse
	 * selection and link hover on those lines stay logical too. Default off.
	 */
	experimentalTerminalBidi?: boolean;
	playSoundOnTaskComplete?: boolean;
	externalApps?: ExternalApp[]; // user-configured apps for "Open in..." menus
	tipsDisabled?: boolean;
	taskOpenMode?: "split" | "fullscreen"; // how active tasks open when clicked
	/**
	 * What Cmd/Ctrl+Click on a file path in terminal output does:
	 * in-app preview modal (default), OS default app, or reveal in the file
	 * manager. Browser/remote mode always previews in-app regardless.
	 */
	terminalPathOpenMode?: TerminalPathOpenMode;
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
	focusMode?: boolean; // when true, queue agent-initiated attention UI and viewer events until Focus Mode ends
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
	/** When false, merged branches show a notice instead of a completion prompt. */
	suggestCompletingTasksAfterMerge?: boolean;
	/**
	 * When false, the Create-PR handoff stops asking the agent to append the
	 * deep link back to the originating task. Default on; the opt-out exists
	 * because a public PR would otherwise advertise that dev3 produced it.
	 */
	prOriginTaskLink?: boolean;
	/**
	 * One-time migration marker: when this is behind the app's current
	 * revision, built-in agent presets get their configuration order
	 * resynced to match the declared order in DEFAULT_AGENTS once, then
	 * this is bumped so the user's own future drag-reordering sticks again.
	 */
	agentsLayoutRevision?: number;
	/**
	 * Opt-in switch for the experimental local `pxpipe-proxy` token-saving proxy.
	 * Default off (undefined ⇒ disabled). While off, the "Fable 5 (cost trick)"
	 * preset is shown but disabled in the picker. Managed from the Global
	 * Settings "Token-saving proxy" section. See PxpipeProxyStatus.
	 */
	pxpipeProxyEnabled?: boolean;
	/**
	 * Custom text the Review toggle in the create-task popup injects into the
	 * description. Absent/blank ⇒ the localized built-in prompt. A project can
	 * override it; see resolveReviewModePrompt.
	 */
	reviewModePrompt?: string;
	/**
	 * Cross-provider "favorite" agent configs shown as quick-pick chips on the
	 * launch picker (Launch/Retry, Spawn, Bug Hunters). Thin pointers, capped at
	 * MAX_FAVORITES with LFU-then-LRU eviction; ordered by uses then recency.
	 * See src/shared/favorites.ts. Undefined ⇒ none.
	 */
	favorites?: FavoriteAgentConfig[];
	/**
	 * User rebinds of app-level keyboard shortcuts, keyed by `keymap.ts` shortcut
	 * id. Sparse on purpose — only rows the user actually changed are stored, so a
	 * changed default still reaches everyone who left that row alone. A slot set to
	 * `null` means "deliberately unbound". See `src/mainview/keymap-store.ts`.
	 */
	keyboardShortcuts?: ShortcutOverrides;
}

/** Every shortcut has one main combo and one optional second way to press it. */
export type ShortcutSlot = "primary" | "alias";

/**
 * A user override for one shortcut. A slot that is absent keeps its default; a
 * slot set to `null` was deliberately emptied by the user. Bindings serialize as
 * `"<Mod|Meta|Ctrl|Alt|Shift>+…+<KeyboardEvent.code>"`, e.g. `"Mod+Shift+KeyP"` —
 * the string form keeps settings.json diffable and lets an unparsable entry be
 * dropped instead of corrupting the whole keymap.
 */
export interface ShortcutOverride {
	primary?: string | null;
	alias?: string | null;
}

/** Sparse: only shortcuts the user actually touched appear here. */
export type ShortcutOverrides = Record<string, ShortcutOverride>;

/** Behavior of Cmd/Ctrl+Click on a file path in terminal output. */
export type TerminalPathOpenMode = "preview" | "system" | "reveal";

/** A path candidate resolved against a task worktree / project directory. */
export interface ResolvedTerminalPath {
	/** Absolute, normalized path that exists on disk. */
	path: string;
	kind: "file" | "directory";
}

/**
 * Content of a file for the in-app terminal path preview modal. `text` is
 * capped (see FILE_PREVIEW_MAX_TEXT_BYTES); larger files report `too-large`
 * so the modal can offer external open instead of shipping megabytes over RPC.
 */
export type FilePreviewResult =
	| { kind: "text"; content: string; truncated: boolean; size: number }
	| { kind: "image"; dataUrl: string; size: number }
	| { kind: "binary"; size: number }
	| { kind: "too-large"; size: number }
	| { kind: "directory" }
	| { kind: "not-found" };

/**
 * Live state of the optional local `pxpipe-proxy` (token-saving image proxy),
 * reported by the `pxpipeProxyStatus/Start/Stop` RPCs. The proxy renders bulky
 * LLM context into PNGs to cut input tokens; it is lossy and opt-in. All fields
 * are computed on demand — nothing is cached across calls.
 */
export interface PxpipeProxyStatus {
	/** The feature toggle in Global Settings. */
	enabled: boolean;
	/** `npx` resolvable on PATH (required to launch the proxy). */
	npxAvailable: boolean;
	npxPath?: string;
	/** The fixed proxy port (`PXPIPE_PROXY_PORT`). */
	port: number;
	/** Some process is LISTENing on the port. */
	portInUse: boolean;
	/** The listener is our managed proxy (our pidfile pid or a descendant). */
	running: boolean;
	/** We spawned it and its pid is alive, but it is not listening yet
	 *  (e.g. `npx` is still downloading the package on first run). */
	starting: boolean;
	/** The port is held by a process that is NOT our proxy — a real conflict. */
	foreignConflict: boolean;
	/** Pid + command name of whatever currently holds the port, if any. */
	holderPid?: number;
	holderName?: string;
	/** The proxy dashboard URL (served by the proxy on the same port). */
	dashboardUrl: string;
}

/**
 * Canonical LLM backend ids. Use these consts instead of raw string literals so
 * the set of providers lives in one place. `anthropic` is the default (direct
 * API); every other value is a third-party backend described in the provider
 * registry (`src/shared/llm-provider.ts`). Adding a provider = adding an id here
 * + a registry entry + its i18n labels.
 */
export const LLM_PROVIDER = {
	/** The agent's own native backend (Anthropic API for Claude, OpenAI for
	 *  Codex). The stored value stays the historical `"anthropic"` — it is the
	 *  persisted default sentinel in users' settings, so renaming it would
	 *  silently reset existing setups. */
	Native: "anthropic",
	/** Amazon Bedrock as the backend for the Claude agent. The stored value
	 *  stays the historical `"bedrock"` — it is persisted in users' settings
	 *  (agent.llmProvider + providerConfig keys), so renaming it would silently
	 *  reset existing Bedrock setups. */
	BedrockClaude: "bedrock",
	/** Amazon Bedrock as the backend for the Codex agent. A separate id because
	 *  the registry pairs each id with one agent command. */
	BedrockCodex: "bedrock-codex",
} as const;

export type LlmProvider = (typeof LLM_PROVIDER)[keyof typeof LLM_PROVIDER];

/** Bedrock cross-region inference-profile prefix (the `<geo>.` part of the model id). */
export type BedrockGeo = "global" | "us" | "eu" | "apac";

/**
 * Per-provider connection settings. Generic across providers so a new backend
 * reuses the same shape — not every field applies to every provider (e.g. `geo`
 * is Bedrock-only). dev3 only owns the provider selection and the model-id
 * mapping. Credentials, region, and AWS profile are NOT configured here — the
 * customer sets those in their own global Claude Code setup (shell env or
 * ~/.claude/settings.json).
 */
export interface ProviderSettings {
	/**
	 * Cross-region inference-profile prefix baked into the mapped model ids
	 * (`global.` | `us.` | `eu.` | `apac.`). Bedrock-only. Changing it
	 * re-populates every non-overridden row of the model table. Defaults to
	 * "global". This is the id prefix only — NOT the AWS_REGION env (the
	 * customer's global Claude config owns credentials/region).
	 */
	geo?: BedrockGeo;
	/**
	 * Per-model id overrides, keyed by the dev3 config model alias (e.g.
	 * "claude-opus-4-8[1m]"). The value is the exact provider-native model id /
	 * inference-profile id / ARN to inject as ANTHROPIC_MODEL, replacing the
	 * built-in alias→provider-id mapping for that model. A key present here is a
	 * "manual" override; deleting it reverts the row to the mapped default.
	 */
	modelOverrides?: Record<string, string>;
}

/**
 * Per-provider settings keyed by provider id (e.g. `{ bedrock: { geo, … } }`).
 * Keyed by id so adding a provider needs no shape change here.
 */
export type ProviderConfig = Partial<Record<LlmProvider, ProviderSettings>>;

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
	/**
	 * Where gh keeps this account's token, verbatim from `gh auth status --json`:
	 * an env var name (`GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/
	 * `GITHUB_ENTERPRISE_TOKEN`), `keyring`, or a `hosts.yml` path. Undefined for
	 * old gh (plain-text status parsing). Env-backed accounts have no stored
	 * credential, so their token must be read from the environment — never via
	 * `gh auth token --user`, which errors "no oauth token found …" (decision 157).
	 */
	tokenSource?: string;
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
	/** Env vars exported into every task session (agent terminals, setup/dev/cleanup
	 *  scripts, column agents). Merged PER KEY across config layers (decision 179). */
	env?: Record<string, string>;
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
	"env",
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
	sensitive?: boolean;
	/** Blank string clears the project override and falls back to global. */
	reviewModePrompt?: string;
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
	env?: Record<string, string>;
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
	/**
	 * Marks a project the user must not show on camera. Inert on its own: every
	 * effect (masked name and tasks, blocked entry, silenced notifications) is
	 * gated on streamer mode being on. See PRODUCT_UX_BIBLE §10 + decision 197.
	 */
	sensitive?: boolean;
	/**
	 * Project-level override of the Review toggle's prompt. Absent/blank ⇒ the
	 * global setting, then the localized built-in. See resolveReviewModePrompt.
	 */
	reviewModePrompt?: string;
}

/**
 * The Review toggle's prompt in effect: project override, then the global custom
 * one, then the localized built-in text. Blank at a layer means "not set", so a
 * cleared field falls through instead of injecting an empty prompt.
 */
export function resolveReviewModePrompt(
	project: Pick<Project, "reviewModePrompt"> | null | undefined,
	globalSettings: Pick<GlobalSettings, "reviewModePrompt"> | null | undefined,
	builtinDefault: string,
): string {
	const set = (value: string | undefined) => (value && value.trim() ? value : undefined);
	return set(project?.reviewModePrompt) ?? set(globalSettings?.reviewModePrompt) ?? builtinDefault;
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

// ---- Board columns (single source of truth for column ordering + visibility) ----

/** Default built-in column order — custom columns are interspersed between these two halves. */
export const DEFAULT_BEFORE_CUSTOM_COLUMNS: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
];
export const DEFAULT_AFTER_CUSTOM_COLUMNS: TaskStatus[] = ["review-by-colleague", "completed", "cancelled"];
export const ALL_BUILTIN_COLUMNS: TaskStatus[] = [...DEFAULT_BEFORE_CUSTOM_COLUMNS, ...DEFAULT_AFTER_CUSTOM_COLUMNS];

/** A single board column: either a built-in status column or a user-defined custom column. */
export type BoardColumnSlot =
	| { type: "builtin"; status: TaskStatus }
	| { type: "custom"; col: CustomColumn };

/**
 * Returns every column a project's board renders, in effective display order,
 * respecting `columnOrder` and hiding columns that don't apply (virtual boards
 * have no AI/PR review; `peerReviewEnabled === false` hides PR review; AI review
 * hides when disabled). Single source of truth for the board's column layout —
 * see [[KanbanBoard]].
 *
 * Pure function of the project plus `opts.occupiedStatuses` — the built-in
 * statuses that currently hold at least one card. **A column holding tasks is
 * never hidden**, whatever the project config says: hiding it would drop those
 * cards off the board with no way to reach them (and it survives a restart,
 * which reads as data loss). Turning peer review off, or converting a board to
 * Operations, therefore leaves an occupied review column standing until it
 * empties out.
 */
export function getBoardColumns(
	project: Pick<Project, "customColumns" | "columnOrder" | "peerReviewEnabled" | "builtinColumnAgents" | "kind">,
	opts: { occupiedStatuses?: ReadonlySet<TaskStatus> } = {},
): BoardColumnSlot[] {
	const cols = project.customColumns ?? [];
	const peerReviewEnabled = project.peerReviewEnabled !== false;
	// AI Review shows by default (on when builtinColumnAgents is unset or has a review-by-ai config).
	const aiReviewEnabled = project.builtinColumnAgents === undefined || !!project.builtinColumnAgents?.["review-by-ai"];
	const occupied = opts.occupiedStatuses;
	// Virtual ("Operations") boards have no diff/PR, so AI Review and PR Review are hidden.
	const isVirtual = project.kind === "virtual";
	const shouldHide = (s: TaskStatus) =>
		!occupied?.has(s) && (
			(isVirtual && (s === "review-by-ai" || s === "review-by-colleague")) ||
			(s === "review-by-colleague" && !peerReviewEnabled) ||
			(s === "review-by-ai" && !aiReviewEnabled)
		);
	const filterBuiltin = (statuses: TaskStatus[]) => statuses.filter((s) => !shouldHide(s));

	if (!project.columnOrder || project.columnOrder.length === 0) {
		return [
			...filterBuiltin(DEFAULT_BEFORE_CUSTOM_COLUMNS).map((s) => ({ type: "builtin" as const, status: s })),
			...cols.map((c) => ({ type: "custom" as const, col: c })),
			...filterBuiltin(DEFAULT_AFTER_CUSTOM_COLUMNS).map((s) => ({ type: "builtin" as const, status: s })),
		];
	}

	const result: BoardColumnSlot[] = [];
	const used = new Set<string>();
	for (const id of project.columnOrder) {
		if ((ALL_BUILTIN_COLUMNS as string[]).includes(id) && shouldHide(id as TaskStatus)) {
			used.add(id);
			continue;
		}
		if ((ALL_BUILTIN_COLUMNS as string[]).includes(id)) {
			result.push({ type: "builtin", status: id as TaskStatus });
			used.add(id);
		} else {
			const col = cols.find((c) => c.id === id);
			if (col) {
				result.push({ type: "custom", col });
				used.add(id);
			}
		}
	}
	// review-by-ai: if missing from stored order, insert right before "review-by-user"
	// so it stays in the correct lifecycle position for existing users.
	if (!used.has("review-by-ai") && !shouldHide("review-by-ai")) {
		const reviewByUserIdx = result.findIndex((c) => c.type === "builtin" && c.status === "review-by-user");
		const slot: BoardColumnSlot = { type: "builtin", status: "review-by-ai" };
		if (reviewByUserIdx !== -1) result.splice(reviewByUserIdx, 0, slot);
		else result.push(slot);
		used.add("review-by-ai");
	}
	// review-by-colleague: if missing from stored order, insert right before "completed".
	if (!used.has("review-by-colleague") && !shouldHide("review-by-colleague")) {
		const completedIdx = result.findIndex((c) => c.type === "builtin" && c.status === "completed");
		const slot: BoardColumnSlot = { type: "builtin", status: "review-by-colleague" };
		if (completedIdx !== -1) result.splice(completedIdx, 0, slot);
		else result.push(slot);
		used.add("review-by-colleague");
	}
	// Append anything else missing (new built-ins, or new custom cols).
	for (const s of ALL_BUILTIN_COLUMNS) {
		if (!used.has(s) && !shouldHide(s)) result.push({ type: "builtin", status: s });
	}
	for (const col of cols) {
		if (!used.has(col.id)) result.push({ type: "custom", col });
	}
	return result;
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

/**
 * Persisted lifecycle runtime hint. The actor verifies this against worktree and
 * tmux reality at boot; it is never treated as authoritative on its own.
 */
export interface TaskRuntimeState {
	runtime: "idle" | "preparing" | "running" | "tearing-down";
	stage?: string;
	runId?: string;
	updatedAt: number;
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
	/**
	 * Task importance {@link TaskPriority}, `P0` (highest) … `P4` (lowest). The
	 * topmost sort key on the board and sidebar (strict bands). Shared across a
	 * whole variant group. Absent only in-memory before the load-time migration
	 * runs; treat a missing value as {@link DEFAULT_PRIORITY} via {@link priorityRank}.
	 */
	priority?: TaskPriority;
	baseBranch: string;
	worktreePath: string | null;
	branchName: string | null;
	/** Sticky identity of the GitHub pull request detected for this task. */
	prNumber?: number | null;
	prUrl?: string | null;
	/** Last rich status fetched for the task's associated GitHub pull request. */
	prStatusCache?: TaskPRStatusCache | null;
	groupId: string | null;
	variantIndex: number | null;
	/** Future-facing links to other tasks; the data layer fills [] for legacy records on load. */
	relations?: TaskRelation[];
	agentId: string | null;
	configId: string | null;
	/**
	 * Managed agent account this task's agent launched under (agent account
	 * switcher). Absent → the registry default (the preselect); `null` →
	 * explicitly the system login (~/.claude / ~/.codex); a string → that managed
	 * account. Persisted so Retry and session recovery re-launch on the same
	 * account. See decisions/2026/07/12/per-launch-agent-account-selection.md.
	 */
	accountId?: string | null;
	createdAt: string;
	updatedAt: string;
	movedAt?: string;
	/**
	 * Start of the current delivery cycle: set on the first `in-progress` move
	 * and reset when a completed/cancelled task is reopened. Used to measure the
	 * time until the next completion without reconstructing history.
	 */
	lifecycleStartedAt?: string;
	/**
	 * Legacy manual position inside a column. Nothing reads or writes it any more —
	 * in-column order is derived from priority + the activity clock (see
	 * sortTasks.ts). Declared only so older values already sitting in `tasks.json`
	 * survive a load/save round-trip instead of being stripped for versions of the
	 * app that still read them (frozen on-disk layout, AGENTS.md).
	 */
	columnOrder?: number;
	tmuxSocket?: string | null;
	/**
	 * Which backend runs this task's PRIMARY terminal. Absent means the legacy
	 * effective backend (tmux) and MUST stay absent — the data layer never
	 * backfills it. Read it through the codec in
	 * `src/shared/terminal-backend-identity` (see decision 165); project and
	 * dev-server terminals are not covered by this field yet.
	 */
	terminalBackend?: TerminalBackendIdentity;
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
	/**
	 * Last worktree/PTY preparation failure. Persisted on the reverted To Do task
	 * so launch feedback survives a missed push/toast; cleared by the next launch.
	 */
	preparationError?: string | null;
	/** Additive lifecycle runtime hint; older app versions ignore this field. */
	runtimeState?: TaskRuntimeState;
	/**
	 * True while a terminal move (→ completed/cancelled) is tearing the task down
	 * server-side: destroying the tmux session, running the cleanup script, and
	 * removing the git worktree. This window can last many seconds and is the
	 * "opposite" of {@link preparing} — the card shows a muted "shutting down"
	 * state and is not openable (there is nothing left to open).
	 *
	 * TRANSIENT — decorated only onto the pushed task snapshot at teardown start
	 * and cleared by the terminal `taskUpdated` push. It is **never persisted**
	 * (unlike `preparing`): the data layer must not receive it, so a crash
	 * mid-teardown or an app reload can never leave a task stuck "shutting down".
	 */
	shuttingDown?: boolean;
	/** When true, native macOS notifications fire on status changes. */
	watched?: boolean;
	/** When true, merge detection reports the merge without suggesting completion. */
	manualCompletion?: boolean;
	/** Persisted agent session state for recovery after tmux/app crash. */
	sessionState?: TaskSessionState | null;
	/**
	 * Last merge-completion prompt shown for this task. The fingerprint tracks
	 * the task branch state, so dismissing the prompt suppresses repeats until
	 * the branch changes.
	 */
	mergeCompletionPrompt?: MergeCompletionPromptState | null;
	/**
	 * True while a task created via the "Scratch Task" button still has no
	 * initial prompt. The `description` holds only a `Scratch — HH:mm`
	 * placeholder used for the title; at launch time the agent receives an
	 * empty prompt instead of the placeholder. Editing in a meaningful
	 * description or title converts it into a normal task and clears this flag.
	 */
	scratch?: boolean;
	/**
	 * True while the task is an unfinished draft parked in To Do by "Save as
	 * draft". A draft is explicitly not ready: every activation path refuses it
	 * (the lifecycle machine rejects the move, see {@link DRAFT_TASK_ACTIVATION_ERROR}),
	 * and clicking its card reopens the New Task popup prefilled. Cleared only by
	 * an explicit save with a non-empty description; the transition is one-way.
	 * Absent/false on every pre-existing task, so older app versions reading the
	 * same `tasks.json` simply see an ordinary To Do task.
	 */
	draft?: boolean;
	/**
	 * True while the task is hibernated: its agent, tmux session and dev server
	 * were killed to reclaim memory, while the worktree, branch, uncommitted
	 * changes, notes and PR state stay untouched. A property of the task, not a
	 * column and not a runtime phase — the task keeps its column, sorts below
	 * every live P4 ({@link taskSortRank}) and refuses column changes
	 * ({@link HIBERNATED_TASK_MOVE_ERROR}) until an explicit wake. Absent/false on
	 * every pre-existing task, so older app versions see an ordinary task.
	 */
	hibernated?: boolean;
	/**
	 * True when the task exists to look at code the local user did not write —
	 * it was started on a remote/fork ref (a pull request, a colleague's branch).
	 * A property of the task, not a column and not a runtime phase: it forbids
	 * nothing, blocks no transition and makes nothing read-only. It states whose
	 * code this is, and it gates one thing — dev3 ignores that branch's committed
	 * command-bearing config (`setupScript`, `devScript`, `cleanupScript`, `env`,
	 * `builtinColumnAgents`) and skips agent trust / `.mcp.json` pre-approval,
	 * using the project's own checkout instead (see decision
	 * `trust-the-branch-not-the-project`).
	 *
	 * Set automatically at creation from the branch the task starts on; the user
	 * owns it and may clear it to run that branch's config deliberately — that is
	 * their call to make, with a warning, not ours to refuse. Absent/false on
	 * every pre-existing task, so older app versions see an ordinary task.
	 */
	foreignCode?: boolean;
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
	 * Displayed in the TaskImageViewer lightbox. Uncapped — every image the task
	 * shared is kept; the copied files live in the project worktree
	 * `shared-images/` dir and die with the worktree. See {@link SharedImage}.
	 */
	sharedImages?: SharedImage[];
	/**
	 * HTML artifacts an agent surfaced via `dev3 show-artifact`, oldest→newest.
	 * Each artifact is stored in its own additive `shared-artifacts/<id>/`
	 * directory together with any `--assets` files and an optional ZIP bundle.
	 */
	sharedArtifacts?: SharedArtifact[];
	/**
	 * Set when the task was created by a scheduled Automation fire (or its
	 * "Run now" action). Drives the clock provenance glyph on the task card and
	 * links the task back to its automation's run history.
	 */
	automationId?: string | null;
	/**
	 * Deferred launch ("Start in…"). Set from the Launch modal when the user
	 * schedules the spawn instead of firing it immediately. Only meaningful on
	 * a `todo` task; the bun scheduled-launch scheduler fires the stored
	 * variants when `at` passes (late fires catch up after app restart) and
	 * the field disappears together with the consumed source task. Cancelled
	 * by setting it back to null.
	 */
	scheduledLaunch?: ScheduledLaunch | null;
	/**
	 * Pending scheduled messages ("Send later") — one-shot texts queued to this
	 * task's live agent/pane, delivered by the bun scheduled-message scheduler
	 * when each item's `at` passes. Unlike {@link Task.scheduledLaunch} this is a
	 * queue; items are removed on delivery, cancel, or an unresolvable target
	 * (drop-with-notice). Explicitly NOT designed to survive a tmux-server / host
	 * restart. Shares the task-card deferred-timer chip slot with
	 * `scheduledLaunch` — the two never coexist (`todo` vs a live-agent task).
	 * See {@link ScheduledMessage}.
	 */
	scheduledMessages?: ScheduledMessage[] | null;
	/**
	 * Cumulative wall-clock time (ms) the task has spent in each status,
	 * finalized on every status transition (see `applyTaskUpdate` in data.ts).
	 * The *current* status's live portion is NOT included until the task leaves
	 * it — consumers add `now - statusEnteredAt` for live totals. Absent on tasks
	 * created before time tracking shipped (their split is unknown, but total
	 * lifetime is still derivable from `createdAt` → `movedAt`). Powers the
	 * Productivity "Time invested" split (agent vs your time). See
	 * {@link AGENT_TIME_STATUSES} / {@link USER_TIME_STATUSES}.
	 */
	statusDurations?: Partial<Record<TaskStatus, number>>;
	/**
	 * ISO time the task entered its CURRENT status. Seeded to `createdAt` at
	 * creation and reset on every status change (not on custom-column-only moves,
	 * which keep the same status). Used with {@link Task.statusDurations} to
	 * credit the live portion of the current status. Absent on legacy tasks.
	 */
	statusEnteredAt?: string;
	/**
	 * Cumulative real UI attention time (ms) — the seconds this task was the
	 * on-screen ("active context") task while the app window was foregrounded and
	 * the user was not idle. Accumulated by the backend focus tracker
	 * (`src/bun/focus-tracker.ts`) and flushed periodically. This is the "your
	 * time" / focus-time metric on the Productivity dashboard — distinct from the
	 * wall-clock a task sits in a user-owned status. Absent/0 on legacy tasks.
	 */
	focusMs?: number;
}

/**
 * Statuses whose wall-clock counts as "agent time" on the Productivity
 * dashboard — the agent is doing work (coding) or an AI is reviewing it.
 */
export const AGENT_TIME_STATUSES: readonly TaskStatus[] = ["in-progress", "review-by-ai"];

/**
 * Statuses whose wall-clock counts as "your time" (the human owns the task):
 * answering questions, reviewing changes, or a colleague's PR review. Note this
 * is wall-clock in-status, NOT the same as the idle-gated `focusMs` attention
 * metric — the dashboard surfaces `focusMs` as the primary "your time" and can
 * use this for a status-based fallback.
 */
export const USER_TIME_STATUSES: readonly TaskStatus[] = [
	"user-questions",
	"review-by-user",
	"review-by-colleague",
];

/** The three durations (ms) a task's lifetime is decomposed into for the dashboard. */
export interface TaskTimeBreakdown {
	/** Wall-clock from creation to completion (or to `now` while still active). */
	totalMs: number;
	/** Wall-clock spent in {@link AGENT_TIME_STATUSES} (coding + AI review). */
	agentMs: number;
	/** Wall-clock spent in {@link USER_TIME_STATUSES} (status-based, not idle-gated). */
	userMs: number;
	/** Idle-gated real UI attention time (`Task.focusMs`). */
	focusMs: number;
	/** True when per-status tracking data exists — agent/user splits are meaningful. */
	hasStatusTracking: boolean;
}

/** The subset of {@link Task} fields {@link computeTaskTimeBreakdown} needs. */
export type TaskTimeInput = Pick<Task, "status" | "createdAt"> & {
	movedAt?: string | null;
	statusDurations?: Partial<Record<TaskStatus, number>>;
	statusEnteredAt?: string | null;
	focusMs?: number;
};

const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "cancelled"];

function sumStatusDurations(
	durations: Partial<Record<TaskStatus, number>>,
	statuses: readonly TaskStatus[],
): number {
	let total = 0;
	for (const s of statuses) total += durations[s] ?? 0;
	return total;
}

/**
 * Decompose a task's lifetime into total / agent / user / focus durations (ms).
 * Pure — `nowMs` is injected for determinism. For an active task, the live
 * portion of the current status (`nowMs - statusEnteredAt`) is credited so the
 * split reflects work in progress; terminal tasks use the finalized durations
 * as-is (their `completed`/`cancelled` sit-time is never credited). `totalMs`
 * is always available; agent/user need per-status tracking (legacy tasks: 0).
 */
export function computeTaskTimeBreakdown(task: TaskTimeInput, nowMs: number): TaskTimeBreakdown {
	const createdMs = Date.parse(task.createdAt);
	const isTerminal = TERMINAL_STATUSES.includes(task.status);
	const endMs = isTerminal ? Date.parse(task.movedAt ?? task.createdAt) : nowMs;
	const totalMs = Number.isFinite(createdMs) && Number.isFinite(endMs) ? Math.max(0, endMs - createdMs) : 0;

	const durations: Partial<Record<TaskStatus, number>> = { ...(task.statusDurations ?? {}) };
	// Credit the live portion of the current status for active tasks only.
	if (!isTerminal && task.statusEnteredAt) {
		const enteredMs = Date.parse(task.statusEnteredAt);
		if (Number.isFinite(enteredMs)) {
			durations[task.status] = (durations[task.status] ?? 0) + Math.max(0, nowMs - enteredMs);
		}
	}

	const hasStatusTracking = task.statusEnteredAt != null || Object.keys(task.statusDurations ?? {}).length > 0;

	return {
		totalMs,
		agentMs: sumStatusDurations(durations, AGENT_TIME_STATUSES),
		userMs: sumStatusDurations(durations, USER_TIME_STATUSES),
		focusMs: Math.max(0, task.focusMs ?? 0),
		hasStatusTracking,
	};
}

/** One row of the Launch modal: the agent + configuration to run, plus the
 *  per-launch managed account (`undefined` → the registry default; `null` → the
 *  system login; a string → that account). Shared by every spawn/schedule RPC so
 *  the trio travels as one named concept instead of a repeated inline literal. */
export interface LaunchVariant {
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
}

/** A one-shot deferred launch persisted on a `todo` task. See {@link Task.scheduledLaunch}. */
export interface ScheduledLaunch {
	/** ISO timestamp when the launch should fire. */
	at: string;
	/** Column the spawned variants land in (same as an immediate launch). */
	targetStatus: TaskStatus;
	/** Agent/config/account variants captured from the Launch modal at schedule time. */
	variants: LaunchVariant[];
}

/**
 * Where a scheduled message is delivered ("Send later").
 * - `agent` (default): resolved dynamically at fire time via the live agent-pane
 *   registry — the agent pane is recreated with fresh ids, so we never store one.
 * - `pane`: a concrete tmux pane id picked from the live layout. Valid only
 *   within one tmux-server lifetime; a stale id takes the drop-with-notice path.
 */
export type ScheduledMessageTarget =
	| { kind: "agent" }
	| { kind: "pane"; paneId: string };

/**
 * A one-shot piece of text queued to a task's live agent/pane, delivered by
 * typing it + Enter when {@link ScheduledMessage.at} passes. The messaging
 * counterpart to {@link ScheduledLaunch} (which defers *spawning* a task); this
 * pokes an already-running agent. See {@link Task.scheduledMessages}.
 */
export interface ScheduledMessage {
	/** Stable id for cancel / send-now. */
	id: string;
	/** The text delivered (send-keys paste + Enter). */
	text: string;
	/** ISO timestamp when it should be delivered. */
	at: string;
	/** Delivery target; `{ kind: "agent" }` by default. */
	target: ScheduledMessageTarget;
	/** Set when another task's agent sent it — wraps the text at fire time. */
	source?: AgentMessageSource;
}

/**
 * The task whose agent authored a cross-task message. Present only for
 * agent-to-agent traffic (`dev3 message` run inside another task's worktree);
 * absent for anything the human sends. Drives the pseudo-XML envelope in
 * `wrapAgentMessage` so the receiver knows who wrote it and how to reply.
 */
export interface AgentMessageSource {
	/** Sender task id (used to skip wrapping when a task messages itself). */
	taskId: string;
	/** Sender's stable `seq` — the reply address (`--task seq:<N>`). */
	seq: number;
	/** Sender's title, for human-readable context in the envelope. */
	title?: string;
}

/** Per-task cap on pending scheduled messages; scheduling past this is rejected. */
export const MAX_SCHEDULED_MESSAGES_PER_TASK = 20;

/**
 * Max length (chars) of a single message's text; longer is rejected outright.
 * Well above what a terminal can be typed into — anything past
 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} is handed over as a file instead.
 */
export const MAX_SCHEDULED_MESSAGE_LENGTH = 80_000;

/**
 * UTF-8 bytes of message body that still travel as typed text. Past this the
 * body is written to a file and the agent receives that path inside the same
 * envelope. Sized by what tmux can physically accept: its client↔server frame is
 * 16 KiB, `send-keys -H` spends 3 bytes per byte of text, and the envelope plus
 * the guarded command list eat the rest — see
 * `decisions/2026/08/10/spill-oversized-agent-messages-to-a-file.md`.
 */
export const AGENT_MESSAGE_SPILL_THRESHOLD_BYTES = 4_000;

/** Raster image extensions accepted by `dev3 show-image` (lowercase, no dot).
 * SVG is excluded on purpose — an inline data-URI SVG in the webview is an XSS
 * vector, and screenshots/renders are raster anyway. Shared by the CLI (early
 * validation) and the bun copy path (authoritative check). */
export const SHARED_IMAGE_EXTS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/** Per-image size cap for `dev3 show-image` (bytes). */
export const MAX_SHARED_IMAGE_BYTES = 25 * 1024 * 1024;

/** Max images accepted in a single `dev3 show-image` invocation. */
export const MAX_SHARED_IMAGES_PER_CALL = 20;

/** Maximum accepted HTML source size for `dev3 show-artifact` (bytes). */
export const MAX_SHARED_ARTIFACT_HTML_BYTES = 5 * 1024 * 1024;

/** Local asset extensions accepted by `dev3 show-artifact --assets`. */
export const SHARED_ARTIFACT_ASSET_EXTS: readonly string[] = ["css", "js", ...SHARED_IMAGE_EXTS];

/** Maximum local assets accepted by one `dev3 show-artifact --assets` call. */
export const MAX_SHARED_ARTIFACT_ASSETS = 40;

/** Per-file size cap for a local HTML artifact asset (bytes). */
export const MAX_SHARED_ARTIFACT_ASSET_BYTES = 25 * 1024 * 1024;

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
	/** Resumable agent session ID for this pane. For agents that pre-assign at
	 *  launch (Claude/Cursor `--session-id`/`--resume`, Gemini `--session-id`) this
	 *  is set immediately; for Codex — which has no launch-time flag — it is filled
	 *  in post-hoc from the lifecycle hook once the session exists (see
	 *  cli-socket-server `captureCodexPaneSession`). Null until known / for agents
	 *  that support neither (OpenCode), which fall back to resume-last. */
	sessionId: string | null;
	/** Agent ID used at launch time. */
	agentId: string | null;
	/** Agent config ID used at launch time. */
	configId: string | null;
	/** Managed agent account used at launch time — re-injected on resume so a
	 *  recovered session keeps running under the same account (absent → default). */
	accountId?: string | null;
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
 * Human-readable task identifier: the per-project sequential number, plus the
 * variant suffix when the task is one of several attempts in a group
 * (e.g. `"981"` or `"981-1"`). No leading `#` — callers add it for display
 * (GlobalHeader) while analytics uses the bare form in page paths. Single source
 * of truth for the seq/variant format shown across the app.
 */
export function taskSeqLabel(task: Pick<Task, "seq" | "variantIndex">): string {
	return task.variantIndex != null ? `${task.seq}-${task.variantIndex}` : `${task.seq}`;
}

/**
 * Returns the effective displayed overview: the user override if set, otherwise
 * the agent-written overview. Mirrors the precedence used in the task cards and
 * CLI. Returns null when neither is present.
 */
export function getTaskOverview(task: Task): string | null {
	return task.userOverview?.trim() || task.overview?.trim() || null;
}

/**
 * Read-only task context rendered in the completion-approval and branch-merged
 * confirm dialogs so the user can recognize *which* project/task a
 * session-destroying prompt is about. Built once on the bun side (where the full
 * task + project are known) and shipped verbatim in the push message — the
 * renderer never re-derives it, so a dialog firing while the user is on another
 * project's board still shows the right project name and labels.
 */
export interface TaskDialogSubject {
	/** Per-project sequential id, variant suffix included (e.g. `"1159"`, `"1159-1"`). */
	seqLabel: string;
	/** Owning project's display name. */
	projectName: string;
	/** Task importance band. */
	priority: TaskPriority;
	/** Resolved labels (id/name/color), in the task's stored order; empty if none. */
	labels: Label[];
	/** Effective overview (user override → agent), or null when neither is set. */
	overview: string | null;
}

/**
 * An agent asking the user to set ANOTHER task running — the payload of the
 * `agentLaunchRequested` push. Carries who asked (`requesterSeq`/`requesterTitle`)
 * so the dialog can name the agent, and the same read-only subject card the
 * completion dialog uses. `scratch` marks the throwaway-peer case, which has no
 * prompt by design.
 */
export interface AgentLaunchRequest {
	requestId: string;
	taskId: string;
	projectId: string;
	taskTitle: string;
	targetStatus: TaskStatus;
	scratch: boolean;
	requesterSeq: number;
	requesterTitle: string;
	subject: TaskDialogSubject;
}

/**
 * Build the {@link TaskDialogSubject} for a task from its project. Pure: resolves
 * `task.labelIds` against `project.labels`, falls back to {@link DEFAULT_PRIORITY}
 * for legacy tasks, and reuses {@link taskSeqLabel}/{@link getTaskOverview}.
 */
export function buildTaskDialogSubject(task: Task, project: Project): TaskDialogSubject {
	const labelById = new Map((project.labels ?? []).map((l) => [l.id, l]));
	const labels = (task.labelIds ?? [])
		.map((id) => labelById.get(id))
		.filter((l): l is Label => l != null);
	return {
		seqLabel: taskSeqLabel(task),
		projectName: project.name,
		priority: task.priority ?? DEFAULT_PRIORITY,
		labels,
		overview: getTaskOverview(task),
	};
}

/**
 * The branch a task's changes should be *compared against* — the base for the
 * branch diff, ahead/behind status, and rebase/merge targets.
 *
 * Normally this is `task.baseBranch` (falling back to the project's default
 * base). PR-review and other "existing branch" tasks are the exception:
 * `deriveTaskBaseBranch` stores their checkout ref as `baseBranch`. The local
 * branch may have the same name, or a fork-qualified checkout ref such as
 * `contributor/feature` may become local branch `feature`. Comparing either
 * checkout shape against HEAD is trivially empty. Fall back to the project's
 * real base branch so diff, commit count, and branch status show the task's
 * actual changes. A variant branch intentionally differs from its source
 * `existingBranch`, so it keeps that source as its comparison base.
 */
export function resolveTaskCompareBaseBranch(
	task: Pick<Task, "baseBranch" | "branchName" | "existingBranch">,
	project: Pick<Project, "defaultBaseBranch">,
): string {
	const projectBase = project.defaultBaseBranch || "main";
	const stored = task.baseBranch || projectBase;
	const existingBranch = task.existingBranch?.trim()
		.replace(/^refs\/remotes\//, "")
		.replace(/^origin\//, "");
	const existingBranchResolvesToTaskBranch = Boolean(
		task.branchName
		&& existingBranch
		&& (
			existingBranch === task.branchName
			|| existingBranch.endsWith(`/${task.branchName}`)
		),
	);
	if (
		(task.branchName && stored === task.branchName)
		|| (existingBranchResolvesToTaskBranch && stored === existingBranch)
	) {
		return projectBase;
	}
	return stored;
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
	/** True until the user opens a viewer containing this image. Absent means read for legacy records. */
	isUnread?: boolean;
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

/** One local asset copied beside a task-bound HTML artifact. */
export interface SharedArtifactAsset {
	/** Relative path preserved so references in HTML and CSS keep working. */
	name: string;
	storedPath: string;
	originalPath: string;
	mime: string;
	bytes: number;
}

/**
 * A task-bound HTML artifact surfaced via `dev3 show-artifact`.
 *
 * The stored HTML contains the stable dev3 artifact theme contract. When
 * `assets` is non-empty, `bundlePath` points at a portable ZIP containing the
 * HTML and every copied local asset at its relative path.
 */
export interface SharedArtifact {
	id: string;
	/** True until the user opens a viewer containing this artifact. Absent means read for legacy records. */
	isUnread?: boolean;
	kind: "html";
	title: string;
	name: string;
	storedPath: string;
	originalPath: string;
	bytes: number;
	createdAt: number;
	assets: SharedArtifactAsset[];
	bundlePath?: string;
	bundleBytes?: number;
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
	prNumber: number | null; // associated PR number for this branch, null if none was detected
	prUrl: string | null; // full GitHub PR URL, null if no associated PR was detected
	mergeCompletionFingerprint: string | null; // stable key for deduping the merged-branch completion prompt
}

/**
 * Work that deleting this task's worktree would destroy, answered with LOCAL git
 * only — no `git fetch`, no `gh`, no cross-task semaphore. {@link BranchStatus}
 * covers the same ground but spends seconds on the network, which is unusable in
 * front of a confirmation dialog (see `confirmTaskCompletion`). Deliberately
 * omits "pushed but not merged": that work lives on the remote, so it is not at
 * risk, and judging it needs a fresh fetch.
 */
export interface UnsavedWork {
	insertions: number;
	deletions: number;
	unpushed: number; // -1 = never pushed, 0 = all pushed, N = N unpushed commits
	ahead: number; // commits ahead of the base branch, per the last known origin ref
}

export type TaskDiffMode = "branch" | "uncommitted" | "unpushed" | "recent";

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
	// For `recent` mode only: the effective (clamped) commit count actually diffed
	// (`HEAD~recentCount..HEAD`). May be smaller than the requested count when the
	// branch has fewer of its own commits; 0 when the branch has none. Null for
	// every other mode. The renderer uses it for the honest "Last N commits" label.
	recentCount: number | null;
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

/** Raw GitHub review decision used to explain why a merge is blocked. */
export type PRReviewDecision = "approved" | "changes_requested" | "review_required";

/** A single check reported by GitHub's `statusCheckRollup`. */
export interface PRCheckInfo {
	name: string;
	status: string | null;
	conclusion: string | null;
	detailsUrl: string | null;
}

/** Mergeability and merge-state status reported by GitHub for an open PR. */
export interface PRMergeState {
	mergeable: string | null;
	status: string | null;
	state?: string | null;
}

/**
 * Persisted rich status for a task's associated pull request. This is deliberately
 * additive task metadata: the renderer can show it immediately while the next
 * GitHub refresh is in flight.
 */
export interface TaskPRStatusCache {
	number: number;
	url: string;
	/** `null` when the GitHub response did not include auto-merge data yet. */
	autoMergeEnabled?: boolean | null;
	ciStatus: PRCIStatus | null;
	reviewState: PRReviewState | null;
	/** Raw GitHub review decision; optional for caches written before this field existed. */
	reviewDecision?: PRReviewDecision | null;
	unresolvedCount: number | null;
	mergeState: PRMergeState | null;
	checks: PRCheckInfo[];
	prTitle: string | null;
	isDraft: boolean | null;
	cachedAt: string;
}

/**
 * Per-task PR badge data shown on the Kanban card: PR number/url (from
 * `getProjectPRs` or sticky task fields) plus optional status detail from the
 * background PR poller's `taskPrStatus` push.
 */
export interface TaskPRBadgeInfo {
	number: number;
	url: string;
	autoMergeEnabled?: boolean | null;
	ciStatus?: PRCIStatus | null;
	reviewState?: PRReviewState | null;
	reviewDecision?: PRReviewDecision | null;
	unresolvedCount?: number | null;
	mergeState?: PRMergeState | null;
	checks?: PRCheckInfo[];
	prTitle?: string | null;
	isDraft?: boolean | null;
}

// ---- PR review comments (read-only GitHub layer in the diff viewer) ----

/** Which side of the PR diff a review thread anchors to (GitHub GraphQL `DiffSide`). */
export type PRReviewThreadSide = "LEFT" | "RIGHT";

/** One comment inside a review thread or the PR conversation. Body is GitHub-flavored markdown. */
export interface PRReviewComment {
	id: string;
	/** GitHub login; null for ghost/deleted accounts. */
	author: string | null;
	/** True when the author is an app/bot account (login ends with `[bot]` or GraphQL __typename Bot). */
	isBot: boolean;
	body: string;
	createdAt: string;
	/** Deep link to this exact comment on GitHub. */
	url: string;
}

/** An inline review thread on the PR diff, as reported by GraphQL `reviewThreads`. */
export interface PRReviewThread {
	id: string;
	path: string;
	/** Line in the current PR-head diff; null when GitHub can no longer anchor it. */
	line: number | null;
	/** Line in the diff the comment was originally made on. */
	originalLine: number | null;
	/** First line of a multi-line thread; null for single-line threads. */
	startLine: number | null;
	diffSide: PRReviewThreadSide;
	isResolved: boolean;
	isOutdated: boolean;
	comments: PRReviewComment[];
}

/** Full read-only comment payload for a task's PR, fetched on diff open / manual refresh. */
export interface TaskPRCommentsPayload {
	prNumber: number;
	prUrl: string;
	fetchedAt: string;
	threads: PRReviewThread[];
	/** Top-level PR conversation comments (issue comments), oldest first. */
	conversation: PRReviewComment[];
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

// ---- System memory (header headroom widget) ----

/**
 * The OS's own verdict on memory scarcity — NOT a percentage threshold we
 * invented. Kept separate from `headroom` on purpose: headroom is a quantity
 * ("can I start another task?"), pressure is a signal ("is the machine hurting?").
 */
export type MemoryPressure = "normal" | "warn" | "critical";

/** Heaviest memory consumers, grouped per application rather than per process. */
export interface MemoryConsumerGroup {
	/** Display name — macOS `.app` bundle name, else executable basename. */
	name: string;
	/** Summed resident memory across the group's processes, in bytes. */
	rss: number;
	/** How many processes the group contains (why one app holds 9 GB). */
	processCount: number;
	/** Executable path of the group's heaviest process. */
	path: string;
	/** Full command line of the heaviest process, length-capped. */
	cmdline: string;
}

export interface MemoryTaskConsumer {
	/** Short task id (first 8 chars), matching `resourceUsageUpdated`. Always set. */
	shortId: string;
	/**
	 * Full task id, or null when the task could not be resolved (its board entry
	 * is gone but its tmux session is still alive). Navigation needs the full id,
	 * so a null here means the row shows its number but is not clickable.
	 */
	taskId: string | null;
	title: string;
	projectId: string;
	rss: number;
}

/**
 * Processes still running inside one finished task's worktree — the app's own
 * leak, grouped per task so the breakdown can name who left them behind.
 */
export interface WorktreeOrphanGroup {
	/** First 8 chars of the task id, read off the worktree path. */
	shortId: string;
	/** Null when no task record survives — the number is still real. */
	taskId: string | null;
	title: string;
	projectId: string;
	/** Command line of the group's root process, for the row's tooltip. */
	command: string;
	pids: number[];
	processCount: number;
	rss: number;
}

export interface SystemMemorySnapshot {
	/** Bytes still available — the number the header pill shows. */
	headroom: number;
	/** Bytes in use, defined to match the OS's own activity monitor. */
	used: number;
	total: number;
	/** Reclaimable file cache: neither used nor free. Shown for honesty. */
	cached: number;
	pressure: MemoryPressure;
	/** True when `pressure` came from a fallback heuristic, not the OS. */
	pressureEstimated: boolean;
	swapUsed: number;
	swapTotal: number;
	/** The swap-out counter moved since the previous sample. */
	swapping: boolean;
	/** Heaviest consumers OUTSIDE dev3 — the comparison that ends the argument. */
	topConsumers: MemoryConsumerGroup[];
	/** The dev3 application process tree itself, separate from its agents. */
	appRss: number;
	/** Tasks with a live tmux session. */
	activeTaskCount: number;
	/**
	 * UPPER BOUND on task memory: shared pages (runtimes, shared libraries) are
	 * counted once per process, so this overstates. Deliberately the least
	 * flattering available figure — labelled as approximate in the UI.
	 */
	tasksRssApprox: number;
	topTasks: MemoryTaskConsumer[];
	/** Median task RSS, or null with no active tasks — never a guessed stand-in. */
	medianTaskRss: number | null;
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
	/** tmux only — empty on a native task, which has no tmux session of any kind. */
	taskSessionName: string;
	/** tmux only — empty on a native task, whose dev server runs in its pane. */
	devSessionName: string;
	/** Which terminal backend hosts this dev server. */
	backend: TaskPaneBackendKind;
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
	/**
	 * Set only when the live state could not be read because tmux itself failed
	 * to launch (e.g. macOS Full Disk Access lost). When present, `running` and
	 * every tmux-derived field are unknown, not authoritative — the CLI renders
	 * "unknown" plus this actionable diagnostic instead of hard-crashing on a raw
	 * `posix_spawn ENOENT`. Additive/optional: older backends never send it and
	 * older CLIs ignore it, so it doesn't affect the frozen on-disk layout.
	 */
	tmuxError?: string;
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
	installUrl?: string;
	customPathError?: boolean;
}

// ---- CLI socket protocol ----

export interface CliRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
	/**
	 * Endpoint token, sent only over the Windows loopback-TCP transport (a
	 * loopback port has none of a socket file's access control). Absent on every
	 * Unix-socket request, which keeps that wire format unchanged. See
	 * `src/shared/cli-endpoint.ts`.
	 */
	token?: string;
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
	/**
	 * Filesystem roots to offer as shortcuts. Windows-only: `parent` is null at
	 * `C:\`, so without these a repo on another drive is unreachable. POSIX has
	 * the single `/` root and omits the field.
	 */
	roots?: string[];
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
	/**
	 * ISO timestamp of the current delivery cycle's first `in-progress` move.
	 * Null for tasks that completed before lifetime tracking existed.
	 */
	lifecycleStartedAt: string | null;
	insertions: number;
	deletions: number;
	files: number;
	/** True when LOC was computed live from an active worktree (not the captured snapshot). */
	liveStats: boolean;
	agentId: string | null;
	groupId: string | null;
	variantIndex: number | null;
	/**
	 * Per-status wall-clock (ms) accumulated on the task — {@link Task.statusDurations}.
	 * The renderer feeds this to {@link computeTaskTimeBreakdown} for the agent/your
	 * time split. `{}` on legacy tasks with no tracking.
	 */
	statusDurations: Partial<Record<TaskStatus, number>>;
	/** ISO time the task entered its current status ({@link Task.statusEnteredAt}); null on legacy tasks. */
	statusEnteredAt: string | null;
	/** Idle-gated real UI attention time in ms ({@link Task.focusMs}); 0 when untracked. */
	focusMs: number;
	/** Launch preset id used by the task's agent, or null when no preset was recorded. */
	configId: string | null;
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
			reorderLabels: {
				params: { projectId: string; labelOrder: string[] };
				response: Project;
			};
			addProject: {
				/** `name` is optional: the backend derives it from the path, which is the
				 *  only side that knows how to spell a path on its own platform. */
				params: { path: string; name?: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			cloneAndAddProject: {
				params: { url: string; baseDir: string; repoName?: string; progressId?: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			createDirectory: {
				params: { parentPath: string; name: string };
				response: { ok: true; path: string } | { ok: false; error: string };
			};
			initAndAddProject: {
				params: { path: string; name?: string };
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
			/** Toggle an (agentId, configId) pair in the global favorites list —
			 *  add it (with LFU-then-LRU eviction once MAX_FAVORITES is reached) or
			 *  remove it if already present. Returns the updated settings so the
			 *  renderer can sync its in-memory copy. */
			toggleFavoriteAgent: {
				params: { agentId: string; configId: string };
				response: GlobalSettings;
			};
			/** Report live state of the local pxpipe token-saving proxy (npx
			 *  availability, port 47821 owner, whether our managed instance runs). */
			pxpipeProxyStatus: {
				params: void;
				response: PxpipeProxyStatus;
			};
			/** Spawn the local pxpipe proxy (`npx -y pxpipe-proxy`) if not already
			 *  running. Returns the fresh status. Throws on npx-missing / port
			 *  held by a foreign process. */
			pxpipeProxyStart: {
				params: void;
				response: PxpipeProxyStatus;
			};
			/** Stop our managed pxpipe proxy (kills the pid tree, frees the port). */
			pxpipeProxyStop: {
				params: void;
				response: PxpipeProxyStatus;
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
			/**
			 * Latest system-memory snapshot, or null before the first poll completes.
			 * Used for the header widget's first render and by the launch-time banner;
			 * live updates arrive on the `systemMemoryUpdated` push.
			 */
			getSystemMemory: {
				params: void;
				response: SystemMemorySnapshot | null;
			};
			/**
			 * Leftover processes inside worktrees of tasks with no live session.
			 * On demand only (breakdown open / startup) — it costs an `lsof` over the
			 * whole process table, which is why it is not part of the memory poll.
			 */
			scanWorktreeOrphans: {
				params: void;
				response: WorktreeOrphanGroup[];
			};
			/** Kill exactly the PIDs the user confirmed. Returns how many actually died. */
			killWorktreeOrphans: {
				params: { pids: number[] };
				response: { killed: number; leftovers: number };
			};
			/** Agent account switcher (multi-account per agent CLI, hot-swap without re-login). */
			listAgentAccounts: {
				params: void;
				response: AgentAccountsState;
			};
			importAgentAccount: {
				params: { kind: AgentAccountKind };
				response: AgentAccount;
			};
			addAgentApiProfile: {
				params: { kind: AgentAccountKind; label?: string; baseUrl?: string; apiKey?: string; model?: string; slotModels?: ClaudeSlotModels; envText?: string };
				response: AgentAccount;
			};
			/** Editable snapshot of an API profile, including the (user's own) API key value for the masked form field. */
			getAgentApiProfileDraft: {
				params: { kind: AgentAccountKind; accountId: string };
				response: { label: string; baseUrl: string; apiKey: string; model: string; slotModels: ClaudeSlotModels; envText: string; hasApiKey: boolean };
			};
			updateAgentApiProfile: {
				params: { kind: AgentAccountKind; accountId: string; label?: string; baseUrl?: string; apiKey?: string; model?: string; slotModels?: ClaudeSlotModels; envText?: string };
				response: AgentAccount;
			};
			prepareAgentAccountLogin: {
				params: { kind: AgentAccountKind };
				response: { accountId: string | null; loginCommand: string };
			};
			completeAgentAccountLogin: {
				params: { kind: AgentAccountKind; accountId?: string | null };
				response: AgentAccount;
			};
			setActiveAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string | null };
				response: void;
			};
			removeAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string };
				response: void;
			};
			renameAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string; label: string };
				response: void;
			};
			searchConversations: {
				params: { projectId: string; query: string; currentTaskId?: string | null; limit?: number; allStatuses?: boolean };
				response: ConversationMatch[];
			};
			createTask: {
				params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string; scratch?: boolean; draft?: boolean; opsWorkDir?: string; priority?: TaskPriority };
				response: Task;
			};
			hibernateTask: {
				// GUI-only, one gesture, no confirmation: kills the agent, the tmux
				// session and the dev server, keeps the worktree. `freedRssBytes` is the
				// last resource-monitor reading before the kill (up to one poll old),
				// so the toast can quote roughly how much memory came back.
				params: { taskId: string; projectId: string };
				response: { task: Task; freedRssBytes: number | null };
			};
			/** Effective terminal backend for one task, plus the live-session gate. */
			getTaskTerminalBackend: {
				params: { taskId: string; projectId: string };
				response: TaskTerminalBackendInfo;
			};
			/**
			 * Per-task override for the NEXT launch. Refused (throws) while either
			 * backend still owns a live session — dev3 never migrates live terminal
			 * state, and a refusal writes nothing on either side.
			 */
			setTaskTerminalBackend: {
				params: { taskId: string; projectId: string; backend: TerminalBackendIdentity };
				response: Task;
			};
			/** Non-throwing probe of this build's native terminal host. */
			getNativeTerminalAvailability: {
				params: void;
				response: NativeTerminalAvailability;
			};
			/**
			 * Machine-local backend for NEW tasks, from its own versioned sidecar
			 * (never settings.json — an older side-by-side build would delete an
			 * unknown key there). Null means no preference ⇒ platform default.
			 */
			getNewTaskTerminalBackend: {
				params: void;
				response: { backend: TerminalBackendIdentity | null };
			};
			setNewTaskTerminalBackend: {
				params: { backend: TerminalBackendIdentity };
				response: { backend: TerminalBackendIdentity };
			};
			setTaskPriority: {
				// Writes the priority to the whole variant group; returns every task
				// it changed so all open surfaces re-render live.
				params: { taskId: string; projectId: string; priority: TaskPriority };
				response: Task[];
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
			// View → Debug probe: fires the same `taskSound` push a real CLI /
			// merge-driven completion fires, with no task involved. `pushed` is false
			// when the completion-sound setting is off (the real push is gated too).
			debugEmitTaskSound: {
				params: { status: "completed" | "cancelled" };
				response: { pushed: boolean };
			};
			cancelTaskPreparation: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			deleteTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			moveTaskToProject: {
				// Relocate a To Do task to another project (true move, same id). The
				// backend re-derives project-scoped fields; the response is the moved
				// task as it now lives in the target project.
				params: { taskId: string; fromProjectId: string; toProjectId: string };
				response: Task;
			};
			editTask: {
				// One optional-field update for a To Do task: whatever is present is
				// written, everything else is left alone. Saving a draft is a single
				// call (and therefore a single persisted write) rather than a create
				// followed by best-effort title/label follow-ups.
				// `draft: false` promotes a draft into an ordinary task and requires a
				// non-empty description; there is no way back to `draft: true`.
				params: {
					taskId: string;
					projectId: string;
					description?: string;
					customTitle?: string | null;
					priority?: TaskPriority;
					labelIds?: string[];
					existingBranch?: string | null;
					draft?: boolean;
				};
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
					variants: LaunchVariant[];
				};
				response: Task[];
			};
			addAttempts: {
				params: {
					taskId: string;
					projectId: string;
					variants: LaunchVariant[];
				};
				response: Task[];
			};
			prepareMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean };
				response: { shouldPrompt: boolean; fingerprint: string | null; shouldNotify?: boolean };
			};
			dismissMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint: string | null };
				response: Task;
			};
			getPtyUrl: {
				params: { taskId: string; resume?: boolean };
				// `hibernated` marks a recovery offer the user must accept explicitly:
				// a hibernated task is never auto-restored just by opening it.
				response:
					| { url: string }
					| { recoverable: true; sessionState: TaskSessionState; hibernated?: true };
			};
			getPanePtyUrl: {
				params: { taskId: string; paneId: string };
				/** `gone` when the pane's host is no longer attachable, so every viewer
				 *  converges on the exited state instead of a dead socket. */
				response: { url: string } | { gone: true };
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
			// `opId` is a renderer-minted correlation id, additive and optional. It is
			// what makes "the handler was never entered" provable: the renderer traces
			// the id when it sends, the handler traces it when it runs, so a request
			// that died in the bridge shows up as an id with only one side (seq 1407).
			runDevServer: {
				params: { taskId: string; projectId: string; opId?: string };
				response: DevServerStatus;
			};
			checkDevServer: {
				params: { taskId: string; projectId: string; opId?: string };
				response: { running: boolean };
			};
			stopDevServer: {
				params: { taskId: string; projectId: string; opId?: string };
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
			getUnsavedWork: {
				params: { taskId: string; projectId: string };
				response: UnsavedWork;
			};
			refreshTaskPrStatus: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			getTaskDiff: {
				params: { taskId: string; projectId: string; mode: TaskDiffMode; compareRef?: string; compareLabel?: string; count?: number };
				response: TaskDiffResponse;
			};
			/**
			 * Read-only comment payload for the task's PR (review threads + top-level
			 * conversation), fetched via gh GraphQL and cached in-memory per task.
			 * `force` bypasses the cache (manual refresh). `null` = task has no PR.
			 */
			getTaskPrComments: {
				params: { taskId: string; projectId: string; force?: boolean };
				response: TaskPRCommentsPayload | null;
			};
			rebaseTask: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: void;
			};
			rebaseTaskViaAgent: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: { delivery: AgentPromptDelivery };
			};
			commitTaskViaAgent: {
				params: { taskId: string; projectId: string };
				response: { delivery: AgentPromptDelivery };
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
				response: { delivery: AgentPromptDelivery };
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
			getRosettaWarning: {
				params: void;
				response: RosettaWarningInfo;
			};
			checkGhAvailable: {
				params: void;
				response: { available: boolean; notInstalled: boolean };
			};
			setCustomBinaryPath: {
				params: { requirementId: string; path: string };
				response: { ok: boolean };
			};
			checkAgentAvailability: {
				params: void;
				response: AgentCheckResult[];
			};
			setAgentBinaryPath: {
				params: { agentId: string; path: string };
				response: void;
			};
			checkCodexBedrockConfig: {
				params: void;
				response: { configured: boolean };
			};
			getChangelogs: {
				params: void;
				response: ChangelogEntry[];
			};
			previewUpdatePopover: {
				params: void;
				response: UpdatePopoverPreview;
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
			/**
			 * Read-and-clear a deep link (`dev3://…`) that arrived while the app sat
			 * window-less in the dock. The reopened renderer pulls it on mount and
			 * navigates — same pull-on-mount pattern as consumePendingNotificationNav.
			 */
			consumePendingDeepLinkNav: {
				params: void;
				response: DeepLinkNav | null;
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
			markTaskSharedItemsRead: {
				params: { taskId: string; projectId: string; kind: "images" | "artifacts"; itemIds: string[] };
				response: Task;
			};
			toggleTaskWatch: {
				params: { taskId: string; projectId: string; watched: boolean };
				response: Task;
			};
			setTaskManualCompletion: {
				params: { taskId: string; projectId: string; manualCompletion: boolean };
				response: Task;
			};
			/**
			 * Own or disown the code a task is about ({@link Task.foreignCode}). Clearing
			 * it lets that branch's `.dev3` config and agent trust apply again — the
			 * user's call, taken with a warning, and it takes effect on the next launch.
			 */
			setTaskForeignCode: {
				params: { taskId: string; projectId: string; foreignCode: boolean };
				response: Task;
			};
			/** Persist a deferred launch on a todo task ("Start in…"). */
			scheduleTaskLaunch: {
				params: {
					taskId: string;
					projectId: string;
					/** ISO timestamp; must be in the future. */
					at: string;
					targetStatus: TaskStatus;
					variants: LaunchVariant[];
				};
				response: Task;
			};
			/** Clear a pending deferred launch without firing it. */
			cancelScheduledLaunch: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			/** Fire a pending deferred launch immediately (badge → "Start now"). */
			startScheduledLaunchNow: {
				params: { taskId: string; projectId: string };
				response: Task[];
			};
			/** Queue a scheduled message ("Send later") on a task with a live agent. */
			scheduleMessage: {
				params: {
					taskId: string;
					projectId: string;
					/** ISO timestamp; must be in the future. */
					at: string;
					text: string;
					target: ScheduledMessageTarget;
				};
				response: Task;
			};
			/** Remove one pending scheduled message without delivering it. */
			cancelScheduledMessage: {
				params: { taskId: string; projectId: string; messageId: string };
				response: Task;
			};
			/** Deliver a pending scheduled message immediately and remove it. */
			sendScheduledMessageNow: {
				params: { taskId: string; projectId: string; messageId: string };
				response: Task;
			};
			/**
			 * Type `text` + Enter into the task's live agent pane right now, without
			 * queueing (the diff viewer's per-thread "send to agent"). Throws when the
			 * task has no live agent session. Payloads over
			 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} are written to a file and the
			 * agent gets that path — `spilledPath` then names the file for the toast.
			 */
			sendAgentMessageNow: {
				params: { taskId: string; projectId: string; text: string };
				response: { spilledPath: string | null };
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
			taskPaneState: {
				params: { taskId: string };
				response: TaskPaneState;
			};
			taskPaneAction: {
				params: { taskId: string; action: TaskPaneAction };
				response: TaskPaneState;
			};
			tmuxNewWindow: {
				params: { taskId: string };
				response: void;
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
			tmuxSearchUpdate: {
				params: { taskId: string; query: string; paneId?: string };
				response: { paneId: string | null; matches: number };
			};
			tmuxSearchStep: {
				params: { taskId: string; paneId: string; direction: "older" | "newer" };
				response: { matches: number };
			};
			tmuxSearchCancel: {
				params: { taskId: string; paneId: string };
				response: void;
			};
			copyTerminalSelection: {
				params: { taskId: string; text: string; mouseTracking: boolean };
				response: { ok: boolean; tool: string | null };
			};
			spawnAgentInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; accountId?: string | null };
				response: void;
			};
			spawnBugHuntersInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; count: number; accountId?: string | null };
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
			readArtifactContent: {
				params: { artifact: SharedArtifact };
				response: { html: string; assets: Array<{ name: string; mime: string; dataUrl: string }> };
			};
			readArtifactDownload: {
				params: { artifact: SharedArtifact };
				response: { fileName: string; mime: "application/zip" | "text/html"; base64: string };
			};
			openArtifactInBrowser: {
				params: { artifact: SharedArtifact };
				response: void;
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
			 * Resolve path candidates detected in terminal output against the
			 * task's worktree (or the project directory for the project
			 * terminal). Only candidates that exist on disk resolve; the rest
			 * map to null so the renderer never linkifies dead paths.
			 */
			resolveTerminalPaths: {
				params: { taskId?: string; projectId?: string; paths: string[] };
				response: { resolved: Record<string, ResolvedTerminalPath | null> };
			};
			/** Open a terminal-linked path in the OS default app or reveal it in the file manager. */
			openTerminalPath: {
				params: { path: string; mode: "system" | "reveal" };
				response: void;
			};
			/** Read file content for the in-app terminal path preview modal. */
			readFilePreview: {
				params: { path: string };
				response: FilePreviewResult;
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
			/**
			 * Scoped renderer→backend diagnostic sink. The renderer's console does not
			 * reach ~/.dev3.0/logs, so a renderer-side symptom is otherwise invisible in
			 * the only record that survives a restart. `tag` namespaces each caller
			 * (e.g. "terminal-copy", "dev-server", "rpc-watchdog"). Deliberately NOT a
			 * general console bridge: every call site is a named investigation, and each
			 * one is expected to be removed when its investigation closes.
			 */
			logRendererDiagnostic: {
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
			resolvePrUrl: {
				params: { projectId: string; url: string };
				response: {
					ok: boolean;
					branch: string | null;
					number: number | null;
					title: string | null;
					isFork: boolean;
					error: string | null;
				};
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
			 * PostHog feature-flag values, pushed by the Electrobun renderer every
			 * FEATURE_FLAG_REFRESH_MS. The bun process never queries PostHog itself
			 * and holds the last pushed value — see src/bun/feature-flags.ts.
			 */
			setFeatureFlags: {
				params: { flags: Record<string, boolean> };
				response: void;
			};
			/** Every declared flag with the value bun currently gates code on. */
			getFeatureFlags: {
				params: void;
				response: Record<string, boolean>;
			};
			/**
			 * The install-wide PostHog distinct id. `seed` is the calling renderer's
			 * own posthog-js id. Adopted when bun has none stored yet, or when the
			 * caller is `authoritative` — the desktop renderer, whose posthog-js
			 * identity outlives every attached browser and is the one flags are
			 * really evaluated against.
			 */
			resolveAnalyticsDistinctId: {
				params: { seed?: string; authoritative?: boolean };
				response: { distinctId: string };
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
			/**
			 * Does the canary update feed carry a build for THIS machine? Derived from the
			 * publisher's own platform list, never from a runtime probe: a missing key in the
			 * release bucket answers 403, so a client could not tell "no build here" from "no
			 * permission". Asked of the host because browser-side platform sniffing would
			 * answer for the wrong machine.
			 */
			checkCanaryChannelAvailable: {
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
			 * Renderer tells the backend when terminal immersive fullscreen owns the
			 * screen so agent notifications can queue until the user exits.
			 */
			setTerminalFocus: {
				params: { active: boolean };
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
			 * Renderer reports its streamer-mode state together with the projects
			 * marked `sensitive`, so the backend can drop OS-level notifications the
			 * renderer cannot intercept. Streamer mode is per-client display state
			 * (localStorage), so the renderer is its only authority; with no client
			 * connected there is no screen to leak on and nothing is silenced.
			 */
			setStreamerPrivacy: {
				params: { streamerMode: boolean; sensitiveProjectIds: string[] };
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
			 * Renderer answers an `agentLaunchRequested` dialog. Approval hands back
			 * the agent/config/account the user picked, and the blocked CLI request
			 * launches the task with it; decline releases it with a refusal.
			 */
			respondToAgentLaunchRequest: {
				params: {
					requestId: string;
					approved: boolean;
					launch?: { agentId: string | null; configId: string | null; accountId?: string | null };
				};
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
			/**
			 * A downloaded update waits for a restart. `reminder` marks a repeat
			 * announcement of an already-announced version (the user postponed it),
			 * telling the renderer to re-show the prompt even though the version
			 * itself did not change.
			 */
			updateAvailable: { version: string; changelog?: UpdateChangelog; reminder?: boolean };
			branchMerged: { taskId: string; projectId: string; taskTitle: string; branchName: string; fingerprint: string | null; subject: TaskDialogSubject; shouldPrompt?: boolean; shouldNotify?: boolean };
			manualCompletionChanged: { taskId: string; projectId: string; manualCompletion: boolean; taskSeq?: number; taskTitle?: string; projectName?: string };
			/**
			 * A branch-merged completion prompt was resolved by declining it
			 * (`dismissMergeCompletionPrompt`). Lets other connected clients — a
			 * second window, or a remote browser served by the same app — close
			 * their still-open "Branch Merged" dialog. The accept path needs no
			 * dedicated event: it is covered by the `taskUpdated` push that moves
			 * the task to `completed` and drops its worktree.
			 */
			mergePromptResolved: { taskId: string; projectId: string; fingerprint: string | null };
			/**
			 * Emitted when an agent runs `dev3 task move --status completed`. The CLI
			 * blocks on the user's decision; the renderer shows an AI-styled confirm
			 * dialog and answers via `respondToAgentCompletionRequest`. `subject`
			 * carries the read-only task context shown in the dialog (overview lives
			 * on `subject.overview`).
			 */
			agentCompletionRequested: { requestId: string; taskId: string; projectId: string; taskTitle: string; subject: TaskDialogSubject };
			/**
			 * Emitted when an agent asks to set ANOTHER task running — either
			 * `dev3 task move --task <other> --status <active>` or
			 * `dev3 task create --scratch --run`. The CLI blocks on the user's
			 * decision; the renderer shows the launch dialog (task context + agent
			 * picker) and answers via `respondToAgentLaunchRequest`. `requesterSeq`
			 * names the asking task so the user can see who wants this.
			 */
			agentLaunchRequested: AgentLaunchRequest;
			portsUpdated: { taskId: string; ports: PortInfo[] };
			exposedPortsChanged: { taskId: string; ports: ExposedPort[] };
			resourceUsageUpdated: { taskId: string; usage: ResourceUsage };
			/**
			 * System-wide memory, sampled in the same resource-monitor tick as the
			 * per-task figures (so the dev3 subtotal and the system total are never
			 * from different moments). Throttled: only emitted when headroom moves
			 * meaningfully, the pressure/swapping signal changes, or the membership
			 * of either top list changes.
			 */
			systemMemoryUpdated: SystemMemorySnapshot;
			/**
			 * Fresh agent rate-limit data (Claude dump / Codex rollouts + monthly credits).
			 * Pushed by the rate-limit monitor whenever the parsed windows change.
			 */
			agentRateLimitsUpdated: AgentRateLimitsReport;
			updateDownloadProgress: { status: string; progress?: number };
			/**
			 * Live `git clone` output for the Add Project modal — the last few
			 * stderr lines, terminal-style (`\r` rewrites collapsed). Correlated
			 * by the `progressId` the renderer passed to `cloneAndAddProject`.
			 */
			cloneProgress: { progressId: string; lines: string[] };
			/**
			 * Emitted when a column-agent launch fails. `movedTo` is the column the task
			 * was parked in as a fallback (built-in AI Review only); absent means the task
			 * stayed put, which is what a custom column does.
			 */
			columnAgentFailed: {
				taskId: string;
				projectId: string;
				column: ColumnAgentIdentity;
				error: string;
				movedTo?: TaskStatus;
				reason?: ColumnAgentFailureReason;
			};
			/**
			 * Emitted when background worktree/PTY preparation for a task fails (e.g.
			 * empty repo, missing base branch). The task is reverted to todo so it is
			 * recoverable; the renderer surfaces this as a toast instead of leaving a
			 * misleading "[session ended]" terminal.
			 */
			taskPreparationFailed: { taskId: string; projectId: string; taskTitle: string; error: string };
			/** Emitted after a global preference is saved. */
			globalSettingsUpdated: GlobalSettings;
			/**
			 * Emitted when the main window gains focus shortly after a watched-task notification fired.
			 * The renderer navigates to the referenced task â implements click-to-open for native notifications.
			 */
			openTaskFromNotification: { taskId: string; projectId: string };
			/**
			 * Navigate from an inbound `dev3://…` deep link while a window is already
			 * open: jump to a task, open a project board, or open the Create Task
			 * modal prefilled with `text`. Cold-start (no window) uses the
			 * consumePendingDeepLinkNav pull instead — see decisions/144.
			 */
			openDeepLink: DeepLinkNav;
			/**
			 * CLI-initiated in-app toast (`dev3 notify`). When `taskId`/`projectId`
			 * are present the toast is clickable and navigates to that task.
			 */
			cliToast: {
				taskId: string | null;
				projectId: string | null;
				message: string;
				level: "info" | "success" | "error";
				/** Optional in-app toast lifetime in milliseconds; omitted uses the default. */
				durationMs?: number;
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
			 * CLI-shared images (`dev3 show-image`). Carries the task's shared images
			 * so the renderer can raise the attention badge and open the lightbox
			 * (auto-open only when already viewing the task). Sole emitter:
			 * `pushCliShowImage` in `src/bun/rpc-handlers/shared.ts`.
			 */
			cliShowImage: {
				taskId: string;
				projectId: string;
				images: SharedImage[];
				newCount: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * CLI-shared HTML artifacts (`dev3 show-artifact`). Same delivery model as
			 * {@link cliShowImage} but for portable HTML bundles.
			 */
			cliShowArtifact: {
				taskId: string;
				projectId: string;
				artifacts: SharedArtifact[];
				newCount: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
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
			 * CI/checks + PR-review state for a task's associated PR, emitted by the
			 * background PR poller (`checkOpenPRsForPromotion`). Drives the CI and
			 * review badges on the task card. Passive status â NOT gated by Focus
			 * Mode (only the bell/notification raised alongside it is).
			 */
			taskPrStatus: {
				projectId: string;
				taskId: string;
				prNumber: number | null;
				prUrl: string | null;
				autoMergeEnabled?: boolean | null;
				ciStatus: PRCIStatus | null;
				reviewState: PRReviewState | null;
				reviewDecision?: PRReviewDecision | null;
				unresolvedCount: number | null;
				mergeState: PRMergeState | null;
				checks: PRCheckInfo[];
				prTitle: string | null;
				isDraft: boolean | null;
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
			showRemoteAccessQR: { qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean; autoStartTunnel?: boolean };
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
			showAbout: { version: string; buildChannel?: string };
			/** Open the Debug → Feature Flags inspector. */
			showFeatureFlags: {};
			/**
			 * Result of a manual "Check for Updates" menu action, surfaced as a toast.
			 * `available` updates flow through `updateAvailable` instead (header plaque).
			 */
			updateCheckOutcome: { status: "none" | "error" | "dev"; version?: string; detail?: string };
		};
	}>;
};
