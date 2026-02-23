import { Utils } from "electrobun/bun";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../shared/types";
import { ACTIVE_STATUSES } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import * as agents from "./agents";
import { loadSettings, saveSettings } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("rpc");

// Will be set by index.ts after window creation
let pushMessage: ((name: string, payload: any) => void) | null = null;

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessage = fn;
}

function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
): Promise<void> {
	const ctx: agents.TemplateContext = {
		taskTitle: task.title,
		taskDescription: task.description,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;

	if (agentId) {
		const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
	} else {
		const resolved = await agents.resolveCommandForProject(
			project,
			task.title,
			task.description,
			worktreePath,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
	}

	// Pre-register worktree as trusted so claude skips the trust dialog
	await agents.ensureClaudeTrust(worktreePath);

	const env = { ...extraEnv, DEV3_TASK_ID: task.id };
	pty.createSession(task.id, worktreePath, tmuxCmd, env);
}

export const handlers = {
	async showConfirm(params: { title: string; message: string }): Promise<boolean> {
		const { response } = await Utils.showMessageBox({
			type: "question",
			title: params.title,
			message: params.message,
			buttons: ["OK", "Cancel"],
			defaultId: 1,
			cancelId: 1,
		});
		return response === 0;
	},

	async getProjects(): Promise<Project[]> {
		log.info("→ getProjects");
		const projects = await data.loadProjects();
		log.info(`← getProjects: ${projects.length} project(s)`);
		return projects;
	},

	async pickFolder(): Promise<string | null> {
		log.info("→ pickFolder (opening native dialog)");
		try {
			const paths = await Utils.openFileDialog({
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});
			log.info("← pickFolder", { paths });
			if (!paths || paths.length === 0) return null;
			return paths[0];
		} catch (err) {
			log.error("pickFolder failed", { error: String(err) });
			throw err;
		}
	},

	async addProject(params: {
		path: string;
		name: string;
	}): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
		log.info("→ addProject", params);
		try {
			const isRepo = await git.isGitRepo(params.path);
			if (!isRepo) {
				log.warn("Not a git repo", { path: params.path });
				return { ok: false, error: "Selected folder is not a git repository" };
			}
			const project = await data.addProject(params.path, params.name);
			// Try to detect default branch
			try {
				const defaultBranch = await git.getDefaultBranch(params.path);
				await data.updateProject(project.id, { defaultBaseBranch: defaultBranch });
				project.defaultBaseBranch = defaultBranch;
			} catch (err) {
				log.warn("Could not detect default branch, keeping 'main'", {
					error: String(err),
				});
			}
			log.info("← addProject OK", { projectId: project.id, name: project.name });
			return { ok: true, project };
		} catch (err) {
			log.error("addProject failed", { error: String(err), params });
			return { ok: false, error: String(err) };
		}
	},

	async removeProject(params: { projectId: string }): Promise<void> {
		log.info("→ removeProject", params);
		await data.removeProject(params.projectId);
		log.info("← removeProject done");
	},

	async updateProjectSettings(params: {
		projectId: string;
		setupScript: string;
		defaultBaseBranch: string;
	}): Promise<Project> {
		log.info("→ updateProjectSettings", { projectId: params.projectId });
		const project = await data.updateProject(params.projectId, {
			setupScript: params.setupScript,
			defaultBaseBranch: params.defaultBaseBranch,
		});
		log.info("← updateProjectSettings done");
		return project;
	},

	async getGlobalSettings(): Promise<GlobalSettings> {
		log.info("→ getGlobalSettings");
		const settings = await loadSettings();
		log.info("← getGlobalSettings", { settings });
		return settings;
	},

	async saveGlobalSettings(params: GlobalSettings): Promise<void> {
		log.info("→ saveGlobalSettings", { params });
		await saveSettings(params);
		log.info("← saveGlobalSettings done");
	},

	async getAgents(): Promise<CodingAgent[]> {
		log.info("→ getAgents");
		const all = await agents.getAllAgents();
		log.info(`← getAgents: ${all.length} agent(s)`);
		return all;
	},

	async saveAgents(params: { agents: CodingAgent[] }): Promise<void> {
		log.info("→ saveAgents", { count: params.agents.length });
		await agents.saveAllAgents(params.agents);
		log.info("← saveAgents done");
	},

	async getTasks(params: { projectId: string }): Promise<Task[]> {
		log.info("→ getTasks", params);
		const project = await data.getProject(params.projectId);
		const tasks = await data.loadTasks(project);
		log.info(`← getTasks: ${tasks.length} task(s)`);
		return tasks;
	},

	async createTask(params: {
		projectId: string;
		description: string;
		status?: TaskStatus;
	}): Promise<Task> {
		log.info("→ createTask", params);
		const project = await data.getProject(params.projectId);
		const status = params.status || "todo";
		const task = await data.addTask(project, params.description, status);

		// If created directly into an active status, set up worktree + PTY
		if (isActive(status)) {
			log.info("Created into active status, creating worktree + PTY", {
				taskId: task.id,
			});
			const wt = await git.createWorktree(project, task);
			await launchTaskPty(project, task, wt.worktreePath);

			const updated = await data.updateTask(project, task.id, {
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← createTask (with worktree)", { taskId: task.id });
			return updated;
		}

		log.info("← createTask", { taskId: task.id });
		return task;
	},

	async moveTask(params: {
		taskId: string;
		projectId: string;
		newStatus: TaskStatus;
	}): Promise<Task> {
		log.info("→ moveTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const oldStatus = task.status;
		const newStatus = params.newStatus;

		log.info(`Moving task ${oldStatus} → ${newStatus}`, { taskId: task.id });

		// todo → active: create worktree + PTY session
		if (!isActive(oldStatus) && isActive(newStatus)) {
			log.info("Transition: inactive → active, creating worktree + PTY");
			const wt = await git.createWorktree(project, task);
			await launchTaskPty(project, task, wt.worktreePath);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree created)", { taskId: task.id });
			return updated;
		}

		// active → completed/cancelled: destroy PTY + worktree
		if (
			isActive(oldStatus) &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			log.info("Transition: active → terminal, destroying PTY + worktree");
			pty.destroySession(task.id);
			await git.removeWorktree(project, task);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: null,
				branchName: null,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree destroyed)", { taskId: task.id });
			return updated;
		}

		// active → active or todo → todo/completed/cancelled (no worktree changes)
		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
		});
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("← moveTask done (status only)", { taskId: task.id });
		return updated;
	},

	async deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ deleteTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		// Cleanup if active
		if (isActive(task.status)) {
			log.info("Task is active, cleaning up PTY + worktree");
			pty.destroySession(task.id);
			await git.removeWorktree(project, task);
		}

		await data.deleteTask(project, task.id);
		log.info("← deleteTask done");
	},

	async spawnVariants(params: {
		taskId: string;
		projectId: string;
		targetStatus: TaskStatus;
		variants: Array<{ agentId: string | null; configId: string | null }>;
	}): Promise<Task[]> {
		log.info("→ spawnVariants", { taskId: params.taskId, count: params.variants.length });
		const project = await data.getProject(params.projectId);
		const sourceTask = await data.getTask(project, params.taskId);

		if (sourceTask.status !== "todo") {
			throw new Error(`Task must be in todo status to spawn variants (got ${sourceTask.status})`);
		}

		const groupId = crypto.randomUUID();
		const resultTasks: Task[] = [];

		for (let i = 0; i < params.variants.length; i++) {
			const variant = params.variants[i];

			const task = await data.addTask(
				project,
				sourceTask.description,
				params.targetStatus,
				{
					groupId,
					variantIndex: i + 1,
					agentId: variant.agentId,
					configId: variant.configId,
				},
			);

			if (isActive(params.targetStatus)) {
				const wt = await git.createWorktree(project, task);
				await launchTaskPty(project, task, wt.worktreePath, variant.agentId, variant.configId);

				const updated = await data.updateTask(project, task.id, {
					worktreePath: wt.worktreePath,
					branchName: wt.branchName,
				});
				pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
				resultTasks.push(updated);
			} else {
				resultTasks.push(task);
			}
		}

		// Delete the original TODO task
		await data.deleteTask(project, params.taskId);

		log.info("← spawnVariants done", { count: resultTasks.length, groupId });
		return resultTasks;
	},

	async getPtyUrl(params: { taskId: string }): Promise<string> {
		log.info("→ getPtyUrl", { taskId: params.taskId });

		// If no PTY session in memory, try to recreate it from persisted task data
		if (!pty.hasSession(params.taskId)) {
			log.info("No PTY session in memory, attempting to restore", {
				taskId: params.taskId.slice(0, 8),
			});

			// Find the task across all projects
			const projects = await data.loadProjects();
			let foundTask: Task | null = null;
			let foundProject: Project | null = null;
			for (const project of projects) {
				try {
					const task = await data.getTask(project, params.taskId);
					foundTask = task;
					foundProject = project;
					break;
				} catch {
					// task not in this project
				}
			}

			if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
				await launchTaskPty(foundProject, foundTask, foundTask.worktreePath);
				log.info("Restored PTY session for active task", {
					taskId: params.taskId.slice(0, 8),
					worktreePath: foundTask.worktreePath,
				});
			} else {
				log.warn("Cannot restore PTY session: task not active or no worktree", {
					taskId: params.taskId.slice(0, 8),
					status: foundTask?.status,
					worktreePath: foundTask?.worktreePath,
				});
			}
		}

		const url = `ws://localhost:7681?session=${params.taskId}`;
		log.info("← getPtyUrl", { url });
		return url;
	},
};
