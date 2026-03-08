import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import type { CliRequest, CliResponse, CustomColumn, Label, Project, Task, TaskStatus, TaskNote, NoteSource } from "../shared/types";
import { ALL_STATUSES, LABEL_COLORS, getAllowedTransitions, titleFromDescription } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import { isActive, launchTaskPty, runCleanupScript, playTaskCompleteSound, getPushMessage } from "./rpc-handlers";
import { loadSettings } from "./settings";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { flushAndEnd, drainSocket, pendingWrites } from "./socket-backpressure";

const log = createLogger("cli-socket");

const MIN_PREFIX_LENGTH = 8;

function findByIdPrefix<T extends { id: string }>(items: T[], prefix: string, entityName: string): T | null {
	const exact = items.find((item) => item.id === prefix);
	if (exact) return exact;

	if (prefix.length < MIN_PREFIX_LENGTH) return null;

	const matches = items.filter((item) => item.id.startsWith(prefix));
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id.slice(0, 12)).join(", ");
		throw new Error(`Ambiguous ${entityName} prefix "${prefix}" matches ${matches.length} items (${ids}). Use a longer prefix.`);
	}
	return matches[0];
}

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
			const task = findByIdPrefix(tasks, taskId, "task");
			if (task) return { project, task };
		} catch (err) {
			// Re-throw ambiguity errors, skip broken task files
			if (err instanceof Error && err.message.startsWith("Ambiguous")) throw err;
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
		const description = (params.description as string | undefined)?.trim() || "";
		if (!projectId) throw new Error("projectId is required");
		if (!title) throw new Error("title is required");

		const project = await data.getProject(projectId);
		// Use description as the task body if provided, otherwise fall back to title
		const task = await data.addTask(project, description || title, "todo");
		// If a separate title was given alongside a description, store it as customTitle
		if (description && title) {
			const updated = await data.updateTask(project, task.id, { customTitle: title });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
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
			const found = findByIdPrefix(tasks, taskId, "task");
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
			updates.customTitle = (params.title as string) || null;
		}
		if (params.description !== undefined) {
			updates.description = params.description as string;
			// Only recompute auto-title if there's no custom override
			if (!task.customTitle && !updates.customTitle) {
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

	"note.add": async (params) => {
		const taskId = params.taskId as string;
		const content = params.content as string;
		if (!taskId) throw new Error("taskId is required");
		if (!content) throw new Error("content is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const now = new Date().toISOString();
		const note: TaskNote = {
			id: crypto.randomUUID(),
			content,
			source: (params.source as NoteSource) ?? "ai",
			createdAt: now,
			updatedAt: now,
		};
		const notes = [...(task.notes ?? []), note];
		const updated = await data.updateTask(project, task.id, { notes });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"note.list": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let task: Task;

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			task = await data.getTask(project, taskId);
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found.task;
		}

		return task.notes ?? [];
	},

	"note.delete": async (params) => {
		const taskId = params.taskId as string;
		const noteId = params.noteId as string;
		if (!taskId) throw new Error("taskId is required");
		if (!noteId) throw new Error("noteId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		const before = task.notes ?? [];
		const noteToDelete = findByIdPrefix(before, noteId, "note");
		if (!noteToDelete) {
			throw new Error(`Note not found: ${noteId}`);
		}
		const notes = before.filter((n) => n.id !== noteToDelete.id);
		const updated = await data.updateTask(project, task.id, { notes });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},

	"label.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		return project.labels ?? [];
	},

	"label.create": async (params) => {
		const projectId = params.projectId as string;
		const name = (params.name as string)?.trim();
		if (!projectId) throw new Error("projectId is required");
		if (!name) throw new Error("name is required");

		const project = await data.getProject(projectId);
		const labels = project.labels ?? [];
		const usedColors = new Set(labels.map((l) => l.color));
		const color = (params.color as string) ?? LABEL_COLORS.find((c) => !usedColors.has(c)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];

		const label: Label = {
			id: crypto.randomUUID(),
			name,
			color,
		};
		await data.updateProject(projectId, { labels: [...labels, label] });
		getPushMessage()?.("projectUpdated", { project: await data.getProject(projectId) });
		return label;
	},

	"label.delete": async (params) => {
		const projectId = params.projectId as string;
		const labelId = params.labelId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!labelId) throw new Error("labelId is required");

		const project = await data.getProject(projectId);
		const labels = project.labels ?? [];
		const label = findByIdPrefix(labels, labelId, "label");
		if (!label) throw new Error(`Label not found: ${labelId}`);

		await data.updateProject(projectId, { labels: labels.filter((l) => l.id !== label.id) });
		// Remove from all tasks
		const tasks = await data.loadTasks(project);
		for (const task of tasks.filter((t) => t.labelIds?.includes(label.id))) {
			await data.updateTask(project, task.id, {
				labelIds: (task.labelIds ?? []).filter((id) => id !== label.id),
			});
		}
		getPushMessage()?.("projectUpdated", { project: await data.getProject(projectId) });
		return { deleted: label.id };
	},

	"task.setLabels": async (params) => {
		const taskId = params.taskId as string;
		const projectId = params.projectId as string;
		const rawLabelIds = params.labelIds as string[];
		if (!taskId) throw new Error("taskId is required");
		if (!projectId) throw new Error("projectId is required");
		if (!Array.isArray(rawLabelIds)) throw new Error("labelIds must be an array");

		const project = await data.getProject(projectId);
		const projectLabels = project.labels ?? [];

		// Resolve short label ID prefixes to full UUIDs
		const labelIds = rawLabelIds.map((raw) => {
			const found = findByIdPrefix(projectLabels, raw, "label");
			if (found) return found.id;
			return raw; // pass through if not found — validation is caller's job
		});

		const task = await data.updateTask(project, taskId, { labelIds });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task });
		return task;
	},

	"task.move": async (params) => {
		const taskId = params.taskId as string;
		const newStatus = params.newStatus as string;
		if (!taskId) throw new Error("taskId is required");
		if (!newStatus) throw new Error("newStatus is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findByIdPrefix(tasks, taskId, "task");
			if (!found) throw new Error(`Task not found: ${taskId}`);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw new Error(`Task not found: ${taskId}`);
			project = found.project;
			task = found.task;
		}

		// Check if this is a custom column ID
		const customColumns = project.customColumns ?? [];
		const customColumn = findByIdPrefix(customColumns, newStatus, "custom column");
		if (customColumn) {
			// Moving from completed/cancelled into a custom column resumes the task
			if (task.status === "completed" || task.status === "cancelled") {
				const wt = await git.createWorktree(project, task);
				await launchTaskPty(project, { ...task, description: "" }, wt.worktreePath, undefined, undefined, true, true);
				const updated = await data.updateTask(project, task.id, {
					status: "in-progress",
					worktreePath: wt.worktreePath,
					branchName: wt.branchName,
					customColumnId: customColumn.id,
				});
				getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
				return updated;
			}
			const updated = await data.updateTask(project, task.id, { customColumnId: customColumn.id });
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// Validate as a built-in status
		const builtinStatus = newStatus as TaskStatus;
		if (!ALL_STATUSES.includes(builtinStatus)) {
			const validCustomIds = customColumns.length > 0
				? `, or one of these custom column IDs: ${customColumns.map((c: CustomColumn) => `${c.id.slice(0, 8)} (${c.name})`).join(", ")}`
				: "";
			throw new Error(`Invalid status: "${newStatus}". Valid built-in statuses: ${ALL_STATUSES.join(", ")}${validCustomIds}`);
		}

		if (task.status === builtinStatus && !task.customColumnId) {
			return task;
		}

		// If moving from a custom column to a built-in status, allow any transition from the task's current status
		const effectiveOldStatus = task.status;
		if (!task.customColumnId) {
			const allowed = getAllowedTransitions(effectiveOldStatus);
			if (!allowed.includes(builtinStatus)) {
				throw new Error(
					`Cannot move task from "${effectiveOldStatus}" to "${builtinStatus}". Allowed: ${allowed.join(", ")}`,
				);
			}
		}

		const oldStatus = effectiveOldStatus;
		const settings = await loadSettings();
		const dropOpts = { dropPosition: settings.taskDropPosition } as const;

		// inactive → active: create worktree + PTY
		if (!isActive(oldStatus) && isActive(builtinStatus)) {
			const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
			const wt = await git.createWorktree(project, task);
			const taskForLaunch = isReopen ? { ...task, description: "" } : task;
			await launchTaskPty(project, taskForLaunch, wt.worktreePath, undefined, undefined, true, isReopen);

			const updated = await data.updateTask(project, task.id, {
				status: builtinStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
				customColumnId: null,
			}, dropOpts);
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → completed/cancelled: destroy PTY, cleanup, remove worktree
		if (isActive(oldStatus) && (builtinStatus === "completed" || builtinStatus === "cancelled")) {
			try { pty.destroySession(task.id); } catch {}
			try { await runCleanupScript(task, project); } catch {}
			playTaskCompleteSound();
			try { await git.removeWorktree(project, task); } catch {}

			const updated = await data.updateTask(project, task.id, {
				status: builtinStatus,
				worktreePath: null,
				branchName: null,
				customColumnId: null,
			}, dropOpts);
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			return updated;
		}

		// active → active or status-only change
		const updated = await data.updateTask(project, task.id, { status: builtinStatus, customColumnId: null }, dropOpts);
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return updated;
	},
};

export async function handleRequest(req: CliRequest): Promise<CliResponse> {
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

				// Handle multiple NDJSON messages in one chunk — accumulate all
				// responses first, then flush once to avoid interleaved partial writes.
				let responseData = "";
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;

					let req: CliRequest;
					try {
						req = JSON.parse(line);
					} catch {
						const errResp: CliResponse = { id: "unknown", ok: false, error: "Invalid JSON" };
						responseData += JSON.stringify(errResp) + "\n";
						continue;
					}

					const resp = await handleRequest(req);
					responseData += JSON.stringify(resp) + "\n";
				}

				flushAndEnd(socket, responseData);
			},
			drain(socket) {
				drainSocket(socket);
			},
			close(socket) {
				pendingWrites.delete(socket);
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
