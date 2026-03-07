import type { Project, Task, TaskStatus } from "../shared/types";
import { titleFromDescription } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";
import { detectClonePaths } from "./cow-clone";

const log = createLogger("data");

const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;

function projectSlug(projectPath: string): string {
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

function tasksFile(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/tasks.json`;
}

async function ensureDir(filePath: string): Promise<void> {
	const dir = filePath.slice(0, filePath.lastIndexOf("/"));
	const proc = spawn(["mkdir", "-p", dir]);
	await proc.exited;
}

// ---- Projects ----

/** Load all projects from disk, including soft-deleted ones. */
async function loadAllProjects(): Promise<Project[]> {
	log.debug("Loading all projects", { file: PROJECTS_FILE });
	try {
		const file = Bun.file(PROJECTS_FILE);
		if (!(await file.exists())) {
			log.info("No projects file yet, returning empty list");
			return [];
		}
		const projects: Project[] = await file.json();
		// Backfill labels for projects created before this field existed
		for (const project of projects) {
			if ((project as any).labels === undefined) {
				project.labels = [];
			}
		}
		log.info(`Loaded ${projects.length} project(s) (including deleted)`);
		return projects;
	} catch (err) {
		log.error("Failed to load projects", { error: String(err) });
		return [];
	}
}

/** Load active (non-deleted) projects. */
export async function loadProjects(): Promise<Project[]> {
	const all = await loadAllProjects();
	return all.filter((p) => !p.deleted);
}

export async function saveProjects(projects: Project[]): Promise<void> {
	log.debug("Saving projects", { count: projects.length, file: PROJECTS_FILE });
	await ensureDir(PROJECTS_FILE);
	await Bun.write(PROJECTS_FILE, JSON.stringify(projects, null, 2));
	log.info(`Saved ${projects.length} project(s)`);
}

export async function addProject(
	path: string,
	name: string,
): Promise<Project> {
	log.info("Adding project", { name, path });
	const projects = await loadAllProjects();
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
			await saveProjects(projects);
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
	await saveProjects(projects);
	log.info("Project added", { id: project.id, name });
	return project;
}

export async function removeProject(projectId: string): Promise<void> {
	log.info("Soft-deleting project", { projectId });
	const projects = await loadAllProjects();
	const idx = projects.findIndex((p) => p.id === projectId);
	if (idx === -1) {
		log.warn("Project not found for soft-delete", { projectId });
		return;
	}
	projects[idx] = { ...projects[idx], deleted: true };
	await saveProjects(projects);
}

export async function updateProject(
	projectId: string,
	updates: Partial<Pick<Project, "setupScript" | "devScript" | "cleanupScript" | "defaultBaseBranch" | "clonePaths" | "labels">>,
): Promise<Project> {
	console.log("[updateProject] updates:", JSON.stringify(updates));
	log.info("Updating project", { projectId, updates });
	const projects = await loadAllProjects();
	const idx = projects.findIndex((p) => p.id === projectId);
	if (idx === -1) throw new Error(`Project not found: ${projectId}`);
	projects[idx] = { ...projects[idx], ...updates };
	console.log("[updateProject] merged project:", JSON.stringify(projects[idx]));
	await saveProjects(projects);
	return projects[idx];
}

export async function getProject(projectId: string): Promise<Project> {
	const projects = await loadAllProjects();
	const project = projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

// ---- Tasks ----

function nextSeq(tasks: Task[]): number {
	if (tasks.length === 0) return 1;
	let max = 0;
	for (const t of tasks) {
		if (t.seq > max) max = t.seq;
	}
	return max + 1;
}

export async function loadTasks(project: Project): Promise<Task[]> {
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
		}

		// Backfill seq for tasks created before seq existed
		const needsSeq = tasks.some((t) => (t as any).seq === undefined);
		if (needsSeq) {
			// Build a map of groupId → seq for tasks that already have seq within a group
			const groupSeqMap = new Map<string, number>();
			for (const t of tasks) {
				if ((t as any).seq !== undefined && t.groupId) {
					groupSeqMap.set(t.groupId, t.seq);
				}
			}

			let current = nextSeq(tasks.filter((t) => (t as any).seq !== undefined));
			for (const t of tasks) {
				if ((t as any).seq !== undefined) continue;
				// Variants sharing a groupId get the same seq
				if (t.groupId && groupSeqMap.has(t.groupId)) {
					t.seq = groupSeqMap.get(t.groupId)!;
				} else {
					t.seq = current;
					if (t.groupId) groupSeqMap.set(t.groupId, current);
					current++;
				}
			}

			log.info("Backfilled seq for tasks", { projectId: project.id });
			await saveTasks(project, tasks);
		}

		log.info(`Loaded ${tasks.length} task(s)`, { projectId: project.id });
		return tasks;
	} catch (err) {
		log.error("Failed to load tasks", { projectId: project.id, error: String(err) });
		return [];
	}
}

export async function saveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const file = tasksFile(project);
	log.debug("Saving tasks", { projectId: project.id, count: tasks.length });
	await ensureDir(file);
	await Bun.write(file, JSON.stringify(tasks, null, 2));
	log.info(`Saved ${tasks.length} task(s)`, { projectId: project.id });
}

export async function addTask(
	project: Project,
	description: string,
	status: TaskStatus = "todo",
	extras?: { groupId?: string; variantIndex?: number; agentId?: string | null; configId?: string | null; seq?: number; existingBranch?: string },
): Promise<Task> {
	const title = titleFromDescription(description);
	log.info("Creating task", { projectId: project.id, title, status });
	const tasks = await loadTasks(project);
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
	};
	tasks.push(task);
	await saveTasks(project, tasks);
	log.info("Task created", { taskId: task.id, seq: task.seq, title });
	return task;
}

export async function updateTask(
	project: Project,
	taskId: string,
	updates: Partial<Task>,
): Promise<Task> {
	log.info("Updating task", { taskId, updates });
	const tasks = await loadTasks(project);
	const idx = tasks.findIndex((t) => t.id === taskId);
	if (idx === -1) throw new Error(`Task not found: ${taskId}`);
	const now = new Date().toISOString();
	const statusChanged = updates.status && updates.status !== tasks[idx].status;
	const movedAtUpdate = statusChanged ? { movedAt: now, columnOrder: undefined } : {};
	tasks[idx] = { ...tasks[idx], ...updates, ...movedAtUpdate, updatedAt: now };
	await saveTasks(project, tasks);
	return tasks[idx];
}

export async function deleteTask(
	project: Project,
	taskId: string,
): Promise<void> {
	log.info("Deleting task", { taskId, projectId: project.id });
	const tasks = await loadTasks(project);
	const filtered = tasks.filter((t) => t.id !== taskId);
	await saveTasks(project, filtered);
}

export async function getTask(
	project: Project,
	taskId: string,
): Promise<Task> {
	const tasks = await loadTasks(project);
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	return task;
}

// ---- Preferences ----

const PREFERENCES_FILE = `${DEV3_HOME}/preferences.json`;

interface Preferences {
	lastPickedFolder?: string;
}

async function loadPreferences(): Promise<Preferences> {
	try {
		const file = Bun.file(PREFERENCES_FILE);
		if (!(await file.exists())) return {};
		return await file.json();
	} catch {
		return {};
	}
}

async function savePreferences(prefs: Preferences): Promise<void> {
	await ensureDir(PREFERENCES_FILE);
	await Bun.write(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

export async function getLastPickedFolder(): Promise<string | undefined> {
	const prefs = await loadPreferences();
	return prefs.lastPickedFolder;
}

export async function setLastPickedFolder(folder: string): Promise<void> {
	const prefs = await loadPreferences();
	prefs.lastPickedFolder = folder;
	await savePreferences(prefs);
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
	log.info("Reordering task in column", { taskId, targetIndex, projectId: project.id });
	const tasks = await loadTasks(project);
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	const columnStatus = task.status;

	// Get all tasks in this column, sorted by existing columnOrder (or createdAt fallback)
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

	// Determine which task IDs to move (variant group moves as a unit)
	const movingIds = new Set<string>();
	if (task.groupId) {
		for (const t of columnTasks) {
			if (t.groupId === task.groupId) movingIds.add(t.id);
		}
	} else {
		movingIds.add(taskId);
	}

	// Split into moving items and remaining items
	const movingItems = columnTasks.filter((t) => movingIds.has(t.id));
	const remaining = columnTasks.filter((t) => !movingIds.has(t.id));

	// Clamp targetIndex
	const clampedIndex = Math.max(0, Math.min(targetIndex, remaining.length));

	// Insert at target position
	remaining.splice(clampedIndex, 0, ...movingItems);

	// Assign sequential columnOrder
	const now = new Date().toISOString();
	const updatedColumnTasks: Task[] = [];
	for (let i = 0; i < remaining.length; i++) {
		const t = remaining[i];
		t.columnOrder = i;
		t.updatedAt = now;
		updatedColumnTasks.push(t);
	}

	await saveTasks(project, tasks);
	log.info("Task reordered", { taskId, targetIndex: clampedIndex, columnTaskCount: updatedColumnTasks.length });
	return updatedColumnTasks;
}
