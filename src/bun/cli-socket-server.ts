import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import type { CliRequest, CliResponse, Project, Task, TaskStatus } from "../shared/types";
import { ALL_STATUSES, getAllowedTransitions, titleFromDescription } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import { isActive, launchTaskPty, runCleanupScript, getPushMessage } from "./rpc-handlers";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("cli-socket");

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
let socketPath = "";

export function getSocketPath(): string {
	return socketPath;
}

function cleanupStaleSockets(): void {
	if (!existsSync(SOCKETS_DIR)) return;

	for (const file of readdirSync(SOCKETS_DIR)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
		if (isNaN(pid)) continue;

		try {
			// Check if process is alive (signal 0 = no signal, just check)
			process.kill(pid, 0);
		} catch {
			// Process is dead — remove stale socket
			const stalePath = `${SOCKETS_DIR}/${file}`;
			log.info("Removing stale socket", { path: stalePath, pid });
			try {
				unlinkSync(stalePath);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

async function resolveTaskAcrossProjects(taskId: string): Promise<{ project: Project; task: Task } | null> {
	const projects = await data.loadProjects();
	for (const project of projects) {
		try {
			const tasks = await data.loadTasks(project);
			// Support both full UUID and 8-char prefix
			const task = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
			if (task) return { project, task };
		} catch {
			// Skip projects with broken task files
		}
	}
	return null;
}

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
	"projects.list": async () => {
		return data.loadProjects();
	},

	"tasks.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");

		const project = await data.getProject(projectId);
		let tasks = await data.loadTasks(project);

		if (params.status) {
			const status = params.status as TaskStatus;
			if (!ALL_STATUSES.includes(status)) {
				throw new Error(`Invalid status: ${status}. Valid: ${ALL_STATUSES.join(", ")}`);
			}
			tasks = tasks.filter((t) => t.status === status);
		}

		return tasks;
	},

	"task.show": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			return data.getTask(project, taskId);
		}

		const found = await resolveTaskAcrossProjects(taskId);
		if (!found) throw new Error(`Task not found: ${taskId}`);
		return found.task;
	},

	"task.create": async (params) => {
		const projectId = params.projectId as string;
		const title = params.title as string;
		if (!projectId) throw new Error("projectId is required");
		if (!title) throw new Error("title is required");

		const project = await data.getProject(projectId);
		const task = await data.addTask(project, title, "todo");
		return task;
	},

	"task.update": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const updates: Partial<Task> = {};
		if (params.title !== undefined) {
			updates.title = params.title as string;
		}
		if (params.description !== undefined) {
			updates.description = params.description as string;
			if (!updates.title) {
				updates.title = titleFromDescription(params.description as string);
			}
		}

		if (Object.keys(updates).length === 0) {
			throw new Error("Nothing to update. Provide --title or --description.");
		}

		const updated = await data.updateTask(project, task.id, updates);
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"task.move": async (params) => {
		const taskId = params.taskId as string;
		const newStatus = params.newStatus as TaskStatus;
		if (!taskId) throw new Error("taskId is required");
		if (!newStatus) throw new Error("newStatus is required");
		if (!ALL_STATUSES.includes(newStatus)) {
			throw new Error(`Invalid status: ${newStatus}. Valid: ${ALL_STATUSES.join(", ")}`);
		}

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const allowed = getAllowedTransitions(task.status);
		if (!allowed.includes(newStatus)) {
			throw new Error(
				`Cannot move task from "${task.status}" to "${newStatus}". Allowed: ${allowed.join(", ")}`,
			);
		}

		const oldStatus = task.status;

		// inactive → active: create worktree + PTY
		if (!isActive(oldStatus) && isActive(newStatus)) {
			const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
			const wt = await git.createWorktree(project, task);
			const taskForLaunch = isReopen ? { ...task, description: "" } : task;
			await launchTaskPty(project, taskForLaunch, wt.worktreePath, undefined, undefined, true);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → completed/cancelled: destroy PTY, cleanup, remove worktree
		if (isActive(oldStatus) && (newStatus === "completed" || newStatus === "cancelled")) {
			try { pty.destroySession(task.id); } catch {}
			try { await runCleanupScript(task, project); } catch {}
			try { await git.removeWorktree(project, task); } catch {}

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: null,
				branchName: null,
			});
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → active or status-only change
		const updated = await data.updateTask(project, task.id, { status: newStatus });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},
};

async function handleRequest(req: CliRequest): Promise<CliResponse> {
	const handler = handlers[req.method];
	if (!handler) {
		return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
	}

	try {
		const result = await handler(req.params);
		return { id: req.id, ok: true, data: result };
	} catch (err) {
		return { id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}

export function startSocketServer(): string {
	mkdirSync(SOCKETS_DIR, { recursive: true });
	cleanupStaleSockets();

	socketPath = `${SOCKETS_DIR}/${process.pid}.sock`;

	// Remove leftover socket file if it exists
	if (existsSync(socketPath)) {
		unlinkSync(socketPath);
	}

	Bun.listen({
		unix: socketPath,
		socket: {
			open() {
				log.debug("CLI client connected");
			},
			async data(socket, raw) {
				const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");

				// Handle multiple NDJSON messages in one chunk
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;

					let req: CliRequest;
					try {
						req = JSON.parse(line);
					} catch {
						const errResp: CliResponse = { id: "unknown", ok: false, error: "Invalid JSON" };
						socket.write(JSON.stringify(errResp) + "\n");
						continue;
					}

					const resp = await handleRequest(req);
					socket.write(JSON.stringify(resp) + "\n");
				}

				socket.end();
			},
			close() {
				log.debug("CLI client disconnected");
			},
			error(_socket, error) {
				log.error("CLI socket error", { error: String(error) });
			},
		},
	});

	log.info("CLI socket server started", { path: socketPath });
	return socketPath;
}

export function stopSocketServer(): void {
	if (socketPath && existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
			log.info("CLI socket removed", { path: socketPath });
		} catch {
			// Ignore cleanup errors
		}
	}
}
