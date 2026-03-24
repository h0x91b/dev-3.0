import type { RPCSchema } from "electrobun/bun";

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

/** Convert "#rrggbb" → "R G B" for use as CSS variable value */
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

// ---- Column Agents ----

export interface ColumnAgentConfig {
	agentId: string; // e.g. "builtin-claude"
	configId: string; // e.g. "claude-bypass-sonnet"
	prompt: string; // prompt sent to the agent
}

export const DEFAULT_REVIEW_PROMPT = `Review all changes on this branch (use git diff against {baseBranch}).
Focus on: bugs, logic errors, runtime failures, duplicated code, security issues.
For medium/high severity: fix directly and commit.
For minor/cosmetic: leave alone. Do NOT break existing functionality.`;

export function getPrimaryStopTarget(autoReviewEnabled?: boolean): TaskStatus {
	return autoReviewEnabled ? "review-by-ai" : "review-by-user";
}

// ---- Coding Agents ----

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan" | "auto";
export type EffortLevel = "low" | "medium" | "high";

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
			{ id: "claude-default", name: "Default (Opus)", model: "opus[1m]", additionalArgs: ["--dangerously-skip-permissions"], version: 2 },
			{ id: "claude-default-sonnet", name: "Default (Sonnet)", model: "sonnet[1m]", additionalArgs: ["--dangerously-skip-permissions"] },
			{ id: "claude-plan", name: "Plan (Opus)", model: "opus[1m]", permissionMode: "plan", additionalArgs: ["--dangerously-skip-permissions"], version: 2 },
			{ id: "claude-plan-sonnet", name: "Plan (Sonnet)", model: "sonnet[1m]", permissionMode: "plan", additionalArgs: ["--dangerously-skip-permissions"] },
			{ id: "claude-bypass", name: "Bypass (Opus)", model: "opus[1m]", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], version: 2 },
			{ id: "claude-bypass-sonnet", name: "Bypass (Sonnet)", model: "sonnet[1m]", permissionMode: "bypassPermissions", additionalArgs: ["--dangerously-skip-permissions"], version: 1 },
			{ id: "claude-auto", name: "Auto (Opus)", model: "opus[1m]", permissionMode: "auto" },
			{ id: "claude-auto-sonnet", name: "Auto (Sonnet)", model: "sonnet[1m]", permissionMode: "auto" },
			{ id: "claude-approvals", name: "Accept Edits (Opus)", model: "opus[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], version: 2 },
			{ id: "claude-approvals-sonnet", name: "Accept Edits (Sonnet)", model: "sonnet[1m]", permissionMode: "acceptEdits", additionalArgs: ["--dangerously-skip-permissions"], version: 1 },
			{ id: "claude-dontask", name: "Don't Ask (Opus)", model: "opus[1m]", permissionMode: "dontAsk", additionalArgs: ["--dangerously-skip-permissions"] },
			{ id: "claude-dontask-sonnet", name: "Don't Ask (Sonnet)", model: "sonnet[1m]", permissionMode: "dontAsk", additionalArgs: ["--dangerously-skip-permissions"] },
		],
		defaultConfigId: "claude-default",
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
				name: "Default (GPT-5.4 Heavy Bypass)",
				model: "gpt-5.4",
				version: 3,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan",
				name: "Plan (GPT-5.4)",
				model: "gpt-5.4",
				version: 2,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-plan-then-bypass",
				name: "Plan then Bypass (GPT-5.4)",
				model: "gpt-5.4",
				version: 2,
				appendPrompt: "First, produce a concrete implementation plan with risks and checkpoints. Do not start making code changes until that plan is complete.",
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			// --- GPT-5.4 ---
			{
				id: "codex-5.4-heavy-bypass",
				name: "GPT-5.4 Heavy Bypass",
				model: "gpt-5.4",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.4-heavy",
				name: "GPT-5.4 Heavy",
				model: "gpt-5.4",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "-c", 'default_permissions="dev3"', "-c", 'model_reasoning_effort="high"'],
			},
			{
				id: "codex-5.4-medium-bypass",
				name: "GPT-5.4 Medium Bypass",
				model: "gpt-5.4",
				version: 2,
				additionalArgs: ["-p", "dev3", "-a", "on-request", "--no-alt-screen", "--sandbox", "danger-full-access", "-c", 'model_reasoning_effort="medium"'],
			},
			{
				id: "codex-5.4-medium",
				name: "GPT-5.4 Medium",
				model: "gpt-5.4",
				version: 2,
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
];

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
	{ id: "zed", name: "Zed", macAppName: "Zed" },
	{ id: "sublime", name: "Sublime Text", macAppName: "Sublime Text" },
];

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	taskDropPosition: "top" | "bottom";
	updateChannel: "stable" | "canary";
	cloneBaseDirectory?: string;
	customBinaryPaths?: Record<string, string>; // requirementId → custom binary path
	agentBinaryPaths?: Record<string, string>; // agentId → resolved binary path
	terminalKeymap?: TerminalKeymapPreset;
	playSoundOnTaskComplete?: boolean;
	externalApps?: ExternalApp[]; // user-configured apps for "Open in..." menus
	tipsDisabled?: boolean;
	taskOpenMode?: "split" | "fullscreen"; // how active tasks open when clicked
}

export interface TipState {
	snoozedUntil: number; // timestamp — all tips hidden until this time
	seen: Record<string, number>; // tipId → last-seen timestamp
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
// (each step jumps ~150° around the color wheel: warm→cool→warm→cool…)
export const LABEL_COLORS = [
	"#ef4444", // red       0°
	"#14b8a6", // teal    174°
	"#f97316", // orange   25°
	"#8b5cf6", // violet  258°
	"#84cc16", // lime     80°
	"#ec4899", // pink    322°
	"#06b6d4", // cyan    188°
	"#eab308", // yellow   50°
	"#3b82f6", // blue    217°
	"#22c55e", // green   142°
	"#f43f5e", // rose    350°
	"#6366f1", // indigo  239°
] as const;

// ---- Repo-local config (.dev3/config.json) ----

export type CompareRefMode = "remote" | "local";

/** Fields that can be stored in .dev3/config.json (repo-level, shareable). */
export interface Dev3RepoConfig {
	setupScript?: string;
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

/** Keys of Dev3RepoConfig — used for merge logic. */
export const DEV3_REPO_CONFIG_KEYS: (keyof Dev3RepoConfig)[] = [
	"setupScript",
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

export type ConfigSource = "repo" | "local" | "app";

export interface ConfigSourceEntry {
	field: string;
	source: ConfigSource;
}

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	devScript: string;
	cleanupScript: string;
	defaultBaseBranch: string;
	defaultCompareRef?: string;
	defaultCompareRefMode?: CompareRefMode;
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
}

export interface Task {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	description: string;
	customTitle?: string | null;
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
	/** True while the worktree is being created (heavy I/O in progress). */
	preparing?: boolean;
	/** When true, native macOS notifications fire on status changes. */
	watched?: boolean;
}

/** Returns the display title: custom override if set, otherwise auto-generated. */
export function getTaskTitle(task: Task): string {
	return task.customTitle || task.title;
}

/** Humanize a status slug for display in notifications (e.g. "in-progress" → "In Progress"). */
export function formatStatus(status: string): string {
	return status
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

export type NoteSource = "user" | "ai";

export interface TaskNote {
	id: string;
	content: string;
	source: NoteSource;
	createdAt: string;
	updatedAt: string;
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
	diffFileNames: string[]; // list of changed file paths in branch vs base
	prNumber: number | null; // open PR number for this branch, null if none
	prUrl: string | null; // GitHub PR URL, null if no PR
}

export interface PRInfo {
	number: number;
	url: string;
	headRefName: string;
}

// ---- Listening ports ----

export interface PortInfo {
	port: number;
	pid: number;
	processName: string; // "node", "bun", "python3"
}

// ---- Resource usage ----

export interface ResourceUsage {
	cpu: number;
	rss: number;
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


// ---- RPC schema ----

export type AppRPCSchema = {
	bun: RPCSchema<{
		requests: {
			getProjects: {
				params: void;
				response: Project[];
			};
			pickFolder: {
				params: void;
				response: string | null;
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
				response: { repo: Dev3RepoConfig; local: Dev3RepoConfig; app: Dev3RepoConfig };
			};
			/** Check which .dev3/ config files exist in the project root. */
			getProjectConfigFiles: {
				params: { projectId: string };
				response: { hasRepoConfig: boolean; hasLocalConfig: boolean };
			};
			/** Save app-level config (~/.dev3.0/data/<slug>/config.json). */
			saveAppConfig: {
				params: { projectId: string } & Dev3RepoConfig;
				response: void;
			};
			/** Update project settings in projects.json (scripts, clone paths, AI Review, etc.). */
			updateProjectSettings: {
				params: { projectId: string } & Dev3RepoConfig;
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
			createTask: {
				params: { projectId: string; description: string; status?: TaskStatus; existingBranch?: string };
				response: Task;
			};
			moveTask: {
				params: { taskId: string; projectId: string; newStatus: TaskStatus; force?: boolean };
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
			showConfirm: {
				params: { title: string; message: string };
				response: boolean;
			};
			getPtyUrl: {
				params: { taskId: string; resume?: boolean };
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
			resolveFilename: {
				params: { filename: string; size: number; lastModified: number };
				response: string | null;
			};
			runDevServer: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			checkDevServer: {
				params: { taskId: string; projectId: string };
				response: { running: boolean };
			};
			stopDevServer: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			openFileBrowser: {
				params: { taskId: string; projectId: string };
				response: { notInstalled: true; installCommand: string; linuxHint?: boolean } | void;
			};
			getBranchStatus: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: BranchStatus;
			};
			rebaseTask: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: void;
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
				params: { taskId: string; projectId: string };
				response: void;
			};
			openPullRequest: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			showDiff: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: void;
			};
			showUncommittedDiff: {
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
			saveUpdateRoute: {
				params: { route: string };
				response: void;
			};
			getUpdateRoute: {
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
				params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV" };
				response: void;
			};
			spawnAgentInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null };
				response: void;
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
			getAvailableApps: {
				params: void;
				response: ExternalApp[];
			};
			logRendererError: {
				params: { description: string; source: "error" | "unhandledrejection" };
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
				response: { branch: string | null; isBaseBranch: boolean };
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
				params: { theme: "dark" | "light" };
				response: void;
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			projectUpdated: { project: Project };
			ptyDied: { taskId: string };
			projectPtyDied: { projectId: string };
			terminalBell: { taskId: string };
			gitOpCompleted: { taskId: string; projectId: string; operation: string; ok: boolean };
			updateAvailable: { version: string };
			branchMerged: { taskId: string; projectId: string; taskTitle: string; branchName: string };
			portsUpdated: { taskId: string; ports: PortInfo[] };
			resourceUsageUpdated: { taskId: string; usage: ResourceUsage };
			updateDownloadProgress: { status: string; progress?: number };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			navigateToSettings: {};
			navigateToGaugeDemo: {};
			navigateToViewportLab: {};
			terminalSoftReset: {};
			terminalHardReset: {};
		};
	}>;
};
