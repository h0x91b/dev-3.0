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
	todo: "#8890b5",
	"in-progress": "#5e9eff",
	"user-questions": "#ffb347",
	"review-by-ai": "#a87cff",
	"review-by-user": "#4fd1c5",
	completed: "#68d391",
	cancelled: "#fc8181",
};

// ---- Coding Agents ----

export interface AgentConfiguration {
	id: string;
	name: string;
	model?: string;
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
		configurations: [{ id: "claude-default", name: "Default" }],
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

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	defaultTmuxCommand: string;
	defaultAgentId: string | null;
	defaultConfigId: string | null;
	defaultBaseBranch: string;
	createdAt: string;
}

export interface Task {
	id: string;
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
					defaultTmuxCommand: string;
					defaultAgentId: string | null;
					defaultConfigId: string | null;
					defaultBaseBranch: string;
				};
				response: Project;
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
				params: { taskId: string; projectId: string; newStatus: TaskStatus };
				response: Task;
			};
			deleteTask: {
				params: { taskId: string; projectId: string };
				response: void;
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
			getPtyUrl: {
				params: { taskId: string };
				response: string;
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			ptyDied: { taskId: string };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: Record<string, never>;
	}>;
};
