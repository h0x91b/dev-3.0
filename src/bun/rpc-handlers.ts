import { Utils } from "electrobun/bun";
import type { Project, Task, TaskStatus } from "../shared/types";
import { ACTIVE_STATUSES } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";

// Will be set by index.ts after window creation
let pushMessage: ((name: string, payload: any) => void) | null = null;

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessage = fn;
}

function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

export const handlers = {
	async getProjects(): Promise<Project[]> {
		return data.loadProjects();
	},

	async pickFolder(): Promise<string | null> {
		const paths = await Utils.openFileDialog({
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		if (!paths || paths.length === 0) return null;
		return paths[0];
	},

	async addProject(params: {
		path: string;
		name: string;
	}): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
		const isRepo = await git.isGitRepo(params.path);
		if (!isRepo) {
			return { ok: false, error: "Selected folder is not a git repository" };
		}
		const project = await data.addProject(params.path, params.name);
		// Try to detect default branch
		try {
			const defaultBranch = await git.getDefaultBranch(params.path);
			await data.updateProject(project.id, { defaultBaseBranch: defaultBranch });
			project.defaultBaseBranch = defaultBranch;
		} catch {
			// Keep "main" as default
		}
		return { ok: true, project };
	},

	async removeProject(params: { projectId: string }): Promise<void> {
		await data.removeProject(params.projectId);
	},

	async updateProjectSettings(params: {
		projectId: string;
		setupScript: string;
		defaultTmuxCommand: string;
		defaultBaseBranch: string;
	}): Promise<Project> {
		return data.updateProject(params.projectId, {
			setupScript: params.setupScript,
			defaultTmuxCommand: params.defaultTmuxCommand,
			defaultBaseBranch: params.defaultBaseBranch,
		});
	},

	async getTasks(params: { projectId: string }): Promise<Task[]> {
		const project = await data.getProject(params.projectId);
		return data.loadTasks(project);
	},

	async createTask(params: { projectId: string; title: string }): Promise<Task> {
		const project = await data.getProject(params.projectId);
		return data.addTask(project, params.title);
	},

	async moveTask(params: {
		taskId: string;
		projectId: string;
		newStatus: TaskStatus;
	}): Promise<Task> {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const oldStatus = task.status;
		const newStatus = params.newStatus;

		// todo → active: create worktree + PTY session
		if (!isActive(oldStatus) && isActive(newStatus)) {
			const wt = await git.createWorktree(project, task);
			const tmuxCmd = project.defaultTmuxCommand || "bash";
			pty.createSession(task.id, wt.worktreePath, tmuxCmd);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → completed/cancelled: destroy PTY + worktree
		if (
			isActive(oldStatus) &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			pty.destroySession(task.id);
			await git.removeWorktree(project, task);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: null,
				branchName: null,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → active or todo → todo/completed/cancelled (no worktree changes)
		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
		});
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	async deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		// Cleanup if active
		if (isActive(task.status)) {
			pty.destroySession(task.id);
			await git.removeWorktree(project, task);
		}

		await data.deleteTask(project, task.id);
	},

	async getPtyUrl(params: { taskId: string }): Promise<string> {
		return `ws://localhost:7681?session=${params.taskId}`;
	},
};
