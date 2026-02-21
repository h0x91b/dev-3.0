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

export interface Project {
	id: string;
	name: string;
	path: string;
	setupScript: string;
	defaultTmuxCommand: string;
	defaultBaseBranch: string;
	createdAt: string;
}

export interface Task {
	id: string;
	projectId: string;
	title: string;
	status: TaskStatus;
	baseBranch: string;
	worktreePath: string | null;
	branchName: string | null;
	createdAt: string;
	updatedAt: string;
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
					defaultBaseBranch: string;
				};
				response: Project;
			};
			getTasks: {
				params: { projectId: string };
				response: Task[];
			};
			createTask: {
				params: { projectId: string; title: string };
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
