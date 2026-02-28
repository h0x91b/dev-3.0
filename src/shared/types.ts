import type { RPCSchema } from "electrobun/bun";

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
	"review-by-ai",
	"review-by-user",
];

export const ALL_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
	"completed",
	"cancelled",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"user-questions": "User Questions",
	"review-by-ai": "Review by AI",
	"review-by-user": "Review by User",
	completed: "Completed",
	cancelled: "Cancelled",
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
	todo: "#38bdf8",
	"in-progress": "#818ef8",
	"user-questions": "#f97316",
	"review-by-ai": "#e879f9",
	"review-by-user": "#fbbf24",
	completed: "#34d399",
	cancelled: "#f87171",
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
		return ["in-progress", "cancelled"];
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
];

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	taskDropPosition: "top" | "bottom";
	updateChannel: "stable" | "canary";
}

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	devScript: string;
	cleanupScript: string;
	defaultBaseBranch: string;
	createdAt: string;
}

export interface Task {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	description: string;
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
				};
				response: Project;
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
				params: { projectId: string; description: string; status?: TaskStatus };
				response: Task;
			};
			moveTask: {
				params: { taskId: string; projectId: string; newStatus: TaskStatus; force?: boolean };
				response: Task;
			};
			deleteTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			editTask: {
				params: { taskId: string; projectId: string; description: string };
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
				params: { taskId: string };
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
			getBranchStatus: {
				params: { taskId: string; projectId: string };
				response: BranchStatus;
			};
			rebaseTask: {
				params: { taskId: string; projectId: string };
				response: { ok: boolean; error?: string };
			};
			mergeTask: {
				params: { taskId: string; projectId: string };
				response: { ok: boolean; error?: string };
			};
			pushTask: {
				params: { taskId: string; projectId: string };
				response: { ok: boolean; error?: string };
			};
			getTerminalPreview: {
				params: { taskId: string };
				response: string | null;
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			ptyDied: { taskId: string };
			terminalBell: { taskId: string };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			navigateToSettings: {};
		};
	}>;
};
