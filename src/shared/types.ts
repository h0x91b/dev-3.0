import type { RPCSchema } from "electrobun/bun";

// ---- Changelog ----

export interface ChangelogEntry {
	date: string; // "2026-03-01"
	type: string; // "feature" | "fix" | "refactor" | "docs" | "chore"
	slug: string; // "system-requirements-check"
	title: string; // First sentence of content (truncated to ~120 chars)
}

// ---- Data models ----

export type TaskStatus =
	| "todo"
	| "in-progress"
	| "user-questions"
	| "review-by-ai"
	| "review-by-user"
	| "completed"
	| "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = [
	"in-progress",
	"user-questions",
	"review-by-user",
	"review-by-ai",
];

export const ALL_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-user",
	"completed",
	"cancelled",
	"review-by-ai",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "Agent is Working",
	"user-questions": "Waiting for You",
	"review-by-ai": "Review by AI",
	"review-by-user": "Review by You",
	completed: "Completed",
	cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
	todo: "#70e3ff",
	"in-progress": "#afbaff",
	"user-questions": "#ffa353",
	"review-by-ai": "#ff8bff",
	"review-by-user": "#ffe55f",
	completed: "#3cf3b0",
	cancelled: "#ff8282",
};

export const STATUS_COLORS_LIGHT: Record<TaskStatus, string> = {
	todo: "#0284c7",
	"in-progress": "#7c3aed",
	"user-questions": "#ea580c",
	"review-by-ai": "#a21caf",
	"review-by-user": "#4d7c0f",
	completed: "#16a34a",
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

// ---- Coding Agents ----

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";
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
}

export interface CodingAgent {
	id: string;
	name: string;
	baseCommand: string;
	isDefault?: boolean;
	configurations: AgentConfiguration[];
	defaultConfigId?: string;
}

export const DEFAULT_AGENTS: CodingAgent[] = [
	{
		id: "builtin-claude",
		name: "Claude",
		baseCommand: "claude",
		isDefault: true,
		configurations: [
			{ id: "claude-default", name: "Default", model: "sonnet" },
			{ id: "claude-plan", name: "Plan (Opus)", model: "opus", permissionMode: "plan" },
			{ id: "claude-approvals-opus", name: "Approvals (Opus)", model: "opus", permissionMode: "acceptEdits" },
			{ id: "claude-approvals-sonnet", name: "Approvals (Sonnet)", model: "sonnet", permissionMode: "acceptEdits" },
			{ id: "claude-bypass-opus", name: "Bypass (Opus)", model: "opus", permissionMode: "bypassPermissions" },
			{ id: "claude-bypass-sonnet", name: "Bypass (Sonnet)", model: "sonnet", permissionMode: "bypassPermissions" },
		],
		defaultConfigId: "claude-default",
	},
	{
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		isDefault: true,
		configurations: [{ id: "codex-default", name: "Default" }],
		defaultConfigId: "codex-default",
	},
	{
		id: "builtin-gemini",
		name: "Gemini",
		baseCommand: "gemini",
		isDefault: true,
		configurations: [{ id: "gemini-default", name: "Default" }],
		defaultConfigId: "gemini-default",
	},
	{
		id: "builtin-cursor",
		name: "Cursor Agent",
		baseCommand: "agent",
		isDefault: true,
		configurations: [
			{ id: "cursor-default", name: "Default (Opus 4.6)", model: "opus-4.6-thinking" },
			{ id: "cursor-plan", name: "Plan (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "plan" },
			{ id: "cursor-yolo", name: "YOLO (Opus 4.6)", model: "opus-4.6-thinking", permissionMode: "bypassPermissions" },
			{ id: "cursor-gpt", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex-high" },
			{ id: "cursor-yolo-gpt", name: "YOLO GPT-5.3 Codex", model: "gpt-5.3-codex-high", permissionMode: "bypassPermissions" },
			{ id: "cursor-gemini", name: "Gemini 3.1 Pro", model: "gemini-3.1-pro" },
		],
		defaultConfigId: "cursor-default",
	},
];

export type TerminalKeymapPreset = "dev3" | "iterm2" | "tmux-native";

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	taskDropPosition: "top" | "bottom";
	updateChannel: "stable" | "canary";
	cloneBaseDirectory?: string;
	customBinaryPaths?: Record<string, string>; // requirementId → custom binary path
	terminalKeymap?: TerminalKeymapPreset;
	playSoundOnTaskComplete?: boolean;
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

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	devScript: string;
	cleanupScript: string;
	defaultBaseBranch: string;
	clonePaths?: string[];
	createdAt: string;
	deleted?: boolean;
	labels?: Label[];
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
}

/** Returns the display title: custom override if set, otherwise auto-generated. */
export function getTaskTitle(task: Task): string {
	return task.customTitle || task.title;
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
}

// ---- Tmux sessions ----

export interface TmuxSessionInfo {
	name: string;
	cwd: string;
	createdAt: number;
	windowCount: number;
	isCleanup: boolean;
	taskTitle?: string;
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
			updateProjectSettings: {
				params: {
					projectId: string;
					setupScript: string;
					devScript: string;
					cleanupScript: string;
					defaultBaseBranch: string;
					clonePaths: string[];
				};
				response: Project;
			};
			detectClonePaths: {
				params: { projectId: string };
				response: string[];
			};
			getGlobalSettings: {
				params: void;
				response: GlobalSettings;
			};
			saveGlobalSettings: {
				params: GlobalSettings;
				response: void;
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
			showConfirm: {
				params: { title: string; message: string };
				response: boolean;
			};
			getPtyUrl: {
				params: { taskId: string; resume?: boolean };
				response: string;
			};
			resolveFilename: {
				params: { filename: string; size: number; lastModified: number };
				response: string | null;
			};
			runDevServer: {
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
			getAppVersion: {
				params: void;
				response: { version: string; channel: string; buildChannel: string };
			};
			checkSystemRequirements: {
				params: void;
				response: RequirementCheckResult[];
			};
			setCustomBinaryPath: {
				params: { requirementId: string; path: string };
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
				params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" };
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
			listBranches: {
				params: { projectId: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
			fetchBranches: {
				params: { projectId: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			projectUpdated: { project: Project };
			ptyDied: { taskId: string };
			terminalBell: { taskId: string };
			gitOpCompleted: { taskId: string; projectId: string; operation: string; ok: boolean };
			updateAvailable: { version: string };
			updateDownloadProgress: { status: string; progress?: number };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			navigateToSettings: {};
			navigateToGaugeDemo: {};
			terminalSoftReset: {};
			terminalHardReset: {};
		};
	}>;
};
