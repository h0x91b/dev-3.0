import type { Project, Task, TaskStatus, TipState } from "../shared/types";
import { titleFromDescription } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";
import { detectClonePaths } from "./cow-clone";
import { withFileLock } from "./file-lock";
import { projectSlug } from "./git";

const log = createLogger("data");

const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;

function tasksFile(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/tasks.json`;
}

async function ensureDir(filePath: string): Promise<void> {
	const dir = filePath.slice(0, filePath.lastIndexOf("/"));
	const proc = spawn(["mkdir", "-p", dir]);
	await proc.exited;
}

// ---- Projects (raw internal helpers — no locking) ----

async function rawLoadAllProjects(): Promise<Project[]> {
	log.debug("Loading all projects", { file: PROJECTS_FILE });
	try {
		const file = Bun.file(PROJECTS_FILE);
		if (!(await file.exists())) {
			log.info("No projects file yet, returning empty list");
			return [];
		}
		const projects: Project[] = await file.json();
		// Backfill labels for projects created before this field existed
		let needsSave = false;
		for (const project of projects) {
			if ((project as any).labels === undefined) {
				project.labels = [];
			}
			if ((project as any).customColumns === undefined) {
				project.customColumns = [];
			}
			// Migrate away from legacy `say` cleanup scripts (was the old default)
			if (project.cleanupScript && /^\s*say\s+/i.test(project.cleanupScript)) {
				project.cleanupScript = "";
				needsSave = true;
			}
		}
		if (needsSave) {
			log.info("Migrated legacy 'say' cleanup scripts, saving projects");
			await Bun.write(PROJECTS_FILE, JSON.stringify(projects, null, 2));
		}
		log.info(`Loaded ${projects.length} project(s) (including deleted)`);
		return projects;
	} catch (err) {
		log.error("Failed to load projects", { error: String(err) });
		return [];
	}
}

async function rawSaveProjects(projects: Project[]): Promise<void> {
	log.debug("Saving projects", { count: projects.length, file: PROJECTS_FILE });
	await ensureDir(PROJECTS_FILE);
	await Bun.write(PROJECTS_FILE, JSON.stringify(projects, null, 2));
	log.info(`Saved ${projects.length} project(s)`);
}

// ---- Projects (public API — all mutators use file lock) ----

/** Load active (non-deleted) projects. */
export async function loadProjects(): Promise<Project[]> {
	const all = await rawLoadAllProjects();
	return all.filter((p) => !p.deleted);
}

export async function saveProjects(projects: Project[]): Promise<void> {
	await withFileLock(PROJECTS_FILE, () => rawSaveProjects(projects));
}

export async function addProject(
	path: string,
	name: string,
): Promise<Project> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Adding project", { name, path });
		const projects = await rawLoadAllProjects();
		const normalizedPath = path.replace(/\/+$/, "");

		const existingIdx = projects.findIndex(
			(p) => p.path.replace(/\/+$/, "") === normalizedPath,
		);

		if (existingIdx !== -1) {
			const existing = projects[existingIdx];
			if (existing.deleted) {
				log.info("Reactivating soft-deleted project", {
					id: existing.id,
					path,
				});
				projects[existingIdx] = { ...existing, deleted: undefined, name };
				await rawSaveProjects(projects);
				return projects[existingIdx];
			}
			log.info("Project already exists, returning existing", {
				id: existing.id,
				path,
			});
			return existing;
		}

		const autoClonePaths = await detectClonePaths(path);
		const project: Project = {
			id: crypto.randomUUID(),
			name,
			path,
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			defaultBaseBranch: "main",
			clonePaths: autoClonePaths,
			createdAt: new Date().toISOString(),
			labels: [],
		};
		projects.push(project);
		await rawSaveProjects(projects);
		log.info("Project added", { id: project.id, name });
		return project;
	});
}

export async function removeProject(projectId: string): Promise<void> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Soft-deleting project", { projectId });
		const projects = await rawLoadAllProjects();
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) {
			log.warn("Project not found for soft-delete", { projectId });
			return;
		}
		projects[idx] = { ...projects[idx], deleted: true };
		await rawSaveProjects(projects);
	});
}

export async function updateProject(
	projectId: string,
	updates: Partial<Pick<Project, "setupScript" | "devScript" | "cleanupScript" | "defaultBaseBranch" | "clonePaths" | "labels" | "customColumns" | "columnOrder" | "peerReviewEnabled">>,
): Promise<Project> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Updating project", { projectId, updates });
		const projects = await rawLoadAllProjects();
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) throw new Error(`Project not found: ${projectId}`);
		projects[idx] = { ...projects[idx], ...updates };
		await rawSaveProjects(projects);
		return projects[idx];
	});
}

export async function getProject(projectId: string): Promise<Project> {
	const projects = await rawLoadAllProjects();
	const project = projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

// ---- Tasks (raw internal helpers — no locking) ----

function nextSeq(tasks: Task[]): number {
	if (tasks.length === 0) return 1;
	let max = 0;
	for (const t of tasks) {
		if (t.seq > max) max = t.seq;
	}
	return max + 1;
}

async function rawLoadTasks(project: Project): Promise<Task[]> {
	const file = tasksFile(project);
	log.debug("Loading tasks", { projectId: project.id, file });
	try {
		const f = Bun.file(file);
		if (!(await f.exists())) {
			log.info("No tasks file yet", { projectId: project.id });
			return [];
		}
		const tasks: Task[] = await f.json();
		// Backfill fields for tasks created before they existed
		for (const task of tasks) {
			if ((task as any).description === undefined) {
				task.description = task.title;
			}
			if ((task as any).groupId === undefined) task.groupId = null;
			if ((task as any).variantIndex === undefined) task.variantIndex = null;
			if ((task as any).agentId === undefined) task.agentId = null;
			if ((task as any).configId === undefined) task.configId = null;
			if ((task as any).labelIds === undefined) task.labelIds = [];
			if ((task as any).notes === undefined) task.notes = [];
			if ((task as any).customTitle === undefined) task.customTitle = null;
			if ((task as any).customColumnId === undefined) task.customColumnId = null;
		}

		// Backfill seq for tasks created before seq existed
		const needsSeq = tasks.some((t) => (t as any).seq === undefined);
		if (needsSeq) {
			const groupSeqMap = new Map<string, number>();
			for (const t of tasks) {
				if ((t as any).seq !== undefined && t.groupId) {
					groupSeqMap.set(t.groupId, t.seq);
				}
			}

			let current = nextSeq(tasks.filter((t) => (t as any).seq !== undefined));
			for (const t of tasks) {
				if ((t as any).seq !== undefined) continue;
				if (t.groupId && groupSeqMap.has(t.groupId)) {
					t.seq = groupSeqMap.get(t.groupId)!;
				} else {
					t.seq = current;
					if (t.groupId) groupSeqMap.set(t.groupId, current);
					current++;
				}
			}

			log.info("Backfilled seq for tasks", { projectId: project.id });
			await rawSaveTasks(project, tasks);
		}

		log.info(`Loaded ${tasks.length} task(s)`, { projectId: project.id });
		return tasks;
	} catch (err) {
		log.error("Failed to load tasks", { projectId: project.id, error: String(err) });
		return [];
	}
}

async function rawSaveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const file = tasksFile(project);
	log.debug("Saving tasks", { projectId: project.id, count: tasks.length });
	await ensureDir(file);
	await Bun.write(file, JSON.stringify(tasks, null, 2));
	log.info(`Saved ${tasks.length} task(s)`, { projectId: project.id });
}

// ---- Tasks (public API — all mutators use file lock) ----

export async function loadTasks(project: Project): Promise<Task[]> {
	return rawLoadTasks(project);
}

export async function saveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const file = tasksFile(project);
	await withFileLock(file, () => rawSaveTasks(project, tasks));
}

export async function addTask(
	project: Project,
	description: string,
	status: TaskStatus = "todo",
	extras?: { groupId?: string; variantIndex?: number; agentId?: string | null; configId?: string | null; seq?: number; existingBranch?: string; preparing?: boolean },
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		const title = titleFromDescription(description);
		log.info("Creating task", { projectId: project.id, title, status });
		const tasks = await rawLoadTasks(project);
		const now = new Date().toISOString();
		const task: Task = {
			id: crypto.randomUUID(),
			seq: extras?.seq ?? nextSeq(tasks),
			projectId: project.id,
			title,
			description,
			status,
			baseBranch: project.defaultBaseBranch,
			worktreePath: null,
			branchName: null,
			groupId: extras?.groupId ?? null,
			variantIndex: extras?.variantIndex ?? null,
			agentId: extras?.agentId ?? null,
			configId: extras?.configId ?? null,
			createdAt: now,
			updatedAt: now,
			tmuxSocket: "dev3",
			labelIds: [],
			...(extras?.existingBranch ? { existingBranch: extras.existingBranch } : {}),
			...(extras?.preparing ? { preparing: true } : {}),
		};
		tasks.push(task);
		await rawSaveTasks(project, tasks);
		log.info("Task created", { taskId: task.id, seq: task.seq, title });
		return task;
	});
}

export async function updateTask(
	project: Project,
	taskId: string,
	updates: Partial<Task>,
	options?: { dropPosition?: "top" | "bottom" },
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Updating task", { taskId, updates });
		const tasks = await rawLoadTasks(project);
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) throw new Error(`Task not found: ${taskId}`);
		const now = new Date().toISOString();
		const statusChanged = updates.status && updates.status !== tasks[idx].status;

		if (statusChanged) {
			const newStatus = updates.status!;
			const dropPosition = options?.dropPosition;

			tasks[idx] = { ...tasks[idx], ...updates, movedAt: now, columnOrder: undefined, updatedAt: now };

			if (dropPosition) {
				const columnTasks = tasks
					.filter((t) => t.status === newStatus && t.id !== taskId)
					.sort((a, b) => {
						if (a.columnOrder !== undefined && b.columnOrder !== undefined) {
							return a.columnOrder - b.columnOrder;
						}
						if (a.columnOrder !== undefined) return -1;
						if (b.columnOrder !== undefined) return 1;
						return a.createdAt < b.createdAt ? -1 : 1;
					});

				if (dropPosition === "top") {
					columnTasks.unshift(tasks[idx]);
				} else {
					columnTasks.push(tasks[idx]);
				}

				for (let i = 0; i < columnTasks.length; i++) {
					columnTasks[i].columnOrder = i;
				}
			}
		} else {
			tasks[idx] = { ...tasks[idx], ...updates, updatedAt: now };
		}

		await rawSaveTasks(project, tasks);
		return tasks[idx];
	});
}

export async function deleteTask(
	project: Project,
	taskId: string,
): Promise<void> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Deleting task", { taskId, projectId: project.id });
		const tasks = await rawLoadTasks(project);
		const filtered = tasks.filter((t) => t.id !== taskId);
		await rawSaveTasks(project, filtered);
	});
}

export async function getTask(
	project: Project,
	taskId: string,
): Promise<Task> {
	const tasks = await rawLoadTasks(project);
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	return task;
}

// ---- Preferences ----

const PREFERENCES_FILE = `${DEV3_HOME}/preferences.json`;

interface Preferences {
	lastPickedFolder?: string;
}

async function rawLoadPreferences(): Promise<Preferences> {
	try {
		const file = Bun.file(PREFERENCES_FILE);
		if (!(await file.exists())) return {};
		return await file.json();
	} catch {
		return {};
	}
}

async function rawSavePreferences(prefs: Preferences): Promise<void> {
	await ensureDir(PREFERENCES_FILE);
	await Bun.write(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

export async function getLastPickedFolder(): Promise<string | undefined> {
	const prefs = await rawLoadPreferences();
	return prefs.lastPickedFolder;
}

export async function setLastPickedFolder(folder: string): Promise<void> {
	return withFileLock(PREFERENCES_FILE, async () => {
		const prefs = await rawLoadPreferences();
		prefs.lastPickedFolder = folder;
		await rawSavePreferences(prefs);
	});
}

/**
 * Reorder a task (or its variant group) within its current status column.
 * Assigns sequential columnOrder (0, 1, 2, ...) to all tasks in the column.
 * Returns the updated column tasks.
 */
export async function reorderTasksInColumn(
	project: Project,
	taskId: string,
	targetIndex: number,
): Promise<Task[]> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Reordering task in column", { taskId, targetIndex, projectId: project.id });
		const tasks = await rawLoadTasks(project);
		const task = tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);

		const columnStatus = task.status;

		const columnTasks = tasks
			.filter((t) => t.status === columnStatus)
			.sort((a, b) => {
				if (a.columnOrder !== undefined && b.columnOrder !== undefined) {
					return a.columnOrder - b.columnOrder;
				}
				if (a.columnOrder !== undefined) return -1;
				if (b.columnOrder !== undefined) return 1;
				return a.createdAt < b.createdAt ? -1 : 1;
			});

		const movingIds = new Set<string>();
		if (task.groupId) {
			for (const t of columnTasks) {
				if (t.groupId === task.groupId) movingIds.add(t.id);
			}
		} else {
			movingIds.add(taskId);
		}

		const movingItems = columnTasks.filter((t) => movingIds.has(t.id));
		const remaining = columnTasks.filter((t) => !movingIds.has(t.id));

		const clampedIndex = Math.max(0, Math.min(targetIndex, remaining.length));
		remaining.splice(clampedIndex, 0, ...movingItems);

		const now = new Date().toISOString();
		const updatedColumnTasks: Task[] = [];
		for (let i = 0; i < remaining.length; i++) {
			const t = remaining[i];
			t.columnOrder = i;
			t.updatedAt = now;
			updatedColumnTasks.push(t);
		}

		await rawSaveTasks(project, tasks);
		log.info("Task reordered", { taskId, targetIndex: clampedIndex, columnTaskCount: updatedColumnTasks.length });
		return updatedColumnTasks;
	});
}

// ---- Tip State ----

const TIP_STATE_FILE = `${DEV3_HOME}/tip-state.json`;

const DEFAULT_TIP_STATE: TipState = {
	snoozedUntil: 0,
	seen: {},
	rotationIndex: 0,
};

async function rawLoadTipState(): Promise<TipState> {
	try {
		const file = Bun.file(TIP_STATE_FILE);
		if (!(await file.exists())) return { ...DEFAULT_TIP_STATE };
		const data = await file.json();
		return { ...DEFAULT_TIP_STATE, ...data };
	} catch {
		return { ...DEFAULT_TIP_STATE };
	}
}

async function rawSaveTipState(state: TipState): Promise<void> {
	await ensureDir(TIP_STATE_FILE);
	await Bun.write(TIP_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function loadTipState(): Promise<TipState> {
	return rawLoadTipState();
}

export async function saveTipState(patch: Partial<TipState>): Promise<TipState> {
	return withFileLock(TIP_STATE_FILE, async () => {
		const current = await rawLoadTipState();
		const updated = { ...current, ...patch };
		if (patch.seen) {
			updated.seen = { ...current.seen, ...patch.seen };
		}
		await rawSaveTipState(updated);
		return updated;
	});
}

export async function resetTipState(): Promise<TipState> {
	return withFileLock(TIP_STATE_FILE, async () => {
		const fresh = { ...DEFAULT_TIP_STATE };
		await rawSaveTipState(fresh);
		return fresh;
	});
}
