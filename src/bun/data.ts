import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import type { Project, Task, TaskStatus, TipState } from "../shared/types";
import { titleFromDescription } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { detectClonePaths } from "./cow-clone";
import { withFileLock } from "./file-lock";
import { projectSlug } from "./git";

const log = createLogger("data");

const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;
const TASK_BACKUPS_DIR = "tasks-backups";
const TASK_BACKUP_RETENTION_HOURS = 72;
const TASK_BACKUP_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/;
type ProjectUpdates = Partial<Pick<Project, "setupScript" | "setupScriptLaunchMode" | "devScript" | "cleanupScript" | "defaultBaseBranch" | "githubAuthHost" | "githubAuthLogin" | "clonePaths" | "labels" | "customColumns" | "columnOrder" | "autoReviewEnabled" | "peerReviewEnabled" | "sparseCheckoutEnabled" | "sparseCheckoutPaths" | "builtinColumnAgents" | "customStatusLabels">>;

export class DataFileReadError extends Error {
	override name = "DataFileReadError";

	constructor(
		message: string,
		public readonly filePath: string,
		public readonly operation: "projects" | "tasks",
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

function tasksFile(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/tasks.json`;
}

function tasksBackupDir(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/${TASK_BACKUPS_DIR}`;
}

function tasksBackupFileName(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 13)}Z.json`;
}

function deriveTaskBaseBranch(project: Project, existingBranch?: string | null): string {
	const normalizedExistingBranch = existingBranch?.trim()
		.replace(/^refs\/remotes\//, "")
		.replace(/^origin\//, "");
	return normalizedExistingBranch || project.defaultBaseBranch;
}

async function ensureDir(filePath: string): Promise<void> {
	const dir = filePath.slice(0, filePath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
}

// ---- Projects (raw internal helpers — no locking) ----

function toDataFileReadError(
	filePath: string,
	operation: "projects" | "tasks",
	err: unknown,
): DataFileReadError {
	const reason = err instanceof Error ? err.message : String(err);
	return new DataFileReadError(
		`Failed to load ${operation} from ${filePath}: ${reason}`,
		filePath,
		operation,
		{ cause: err },
	);
}

async function rawLoadAllProjects(options?: { strict?: boolean; persistMigrations?: boolean }): Promise<Project[]> {
	log.debug("Loading all projects", { file: PROJECTS_FILE });
	try {
		const projects = JSON.parse(await readFile(PROJECTS_FILE, "utf8")) as Project[];
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
			// Migrate legacy aiReview → builtinColumnAgents
			const legacy = (project as any).aiReview;
			if (legacy && !project.builtinColumnAgents) {
				if (legacy.enabled !== false) {
					project.builtinColumnAgents = {
						"review-by-ai": {
							agentId: legacy.agentId ?? "builtin-claude",
							configId: legacy.configId ?? "claude-bypass-sonnet",
							prompt: legacy.reviewPrompt ?? "",
						},
					};
				}
				delete (project as any).aiReview;
				needsSave = true;
			}
		}
		if (needsSave && options?.persistMigrations) {
			log.info("Migrated legacy 'say' cleanup scripts, saving projects");
			await rawSaveProjects(projects);
		}
		log.info(`Loaded ${projects.length} project(s) (including deleted)`);
		return projects;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			log.info("No projects file yet, returning empty list");
			return [];
		}
		log.error("Failed to load projects", { error: String(err) });
		if (options?.strict) {
			throw toDataFileReadError(PROJECTS_FILE, "projects", err);
		}
		return [];
	}
}

async function rawSaveProjects(projects: Project[]): Promise<void> {
	log.debug("Saving projects", { count: projects.length, file: PROJECTS_FILE });
	await ensureDir(PROJECTS_FILE);
	await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
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

export async function reorderProjects(projectIds: string[]): Promise<Project[]> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Reordering projects", { projectIds });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const seen = new Set<string>();
		const orderedActive: Project[] = [];

		for (const projectId of projectIds) {
			if (seen.has(projectId)) continue;
			const project = projects.find((candidate) => candidate.id === projectId && !candidate.deleted);
			if (!project) continue;
			orderedActive.push(project);
			seen.add(project.id);
		}

		for (const project of projects) {
			if (!project.deleted && !seen.has(project.id)) {
				orderedActive.push(project);
				seen.add(project.id);
			}
		}

		const deleted = projects.filter((project) => project.deleted);
		const reordered = [...orderedActive, ...deleted];
		await rawSaveProjects(reordered);
		log.info("Projects reordered", { count: orderedActive.length });
		return orderedActive;
	});
}

export async function addProject(
	path: string,
	name: string,
): Promise<Project> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Adding project", { name, path });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
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
			setupScriptLaunchMode: "parallel",
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
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
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
	updates: ProjectUpdates,
): Promise<Project> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Updating project", { projectId, updates });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) throw new Error(`Project not found: ${projectId}`);
		projects[idx] = { ...projects[idx], ...updates };
		await rawSaveProjects(projects);
		return projects[idx];
	});
}

export async function updateProjectWith<T>(
	projectId: string,
	mutator: (project: Project) => Promise<{ updates: ProjectUpdates; result: T }> | { updates: ProjectUpdates; result: T },
): Promise<{ project: Project; result: T }> {
	return withFileLock(PROJECTS_FILE, async () => {
		log.info("Updating project with mutator", { projectId });
		const projects = await rawLoadAllProjects({ strict: true, persistMigrations: true });
		const idx = projects.findIndex((p) => p.id === projectId);
		if (idx === -1) throw new Error(`Project not found: ${projectId}`);
		const { updates, result } = await mutator(projects[idx]);
		projects[idx] = { ...projects[idx], ...updates };
		await rawSaveProjects(projects);
		return { project: projects[idx], result };
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

async function rawLoadTasks(project: Project, options?: { strict?: boolean; persistMigrations?: boolean }): Promise<Task[]> {
	const file = tasksFile(project);
	log.debug("Loading tasks", { projectId: project.id, file });
	try {
		const tasks = JSON.parse(await readFile(file, "utf8")) as Task[];
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
			if ((task as any).overview === undefined) task.overview = null;
			if ((task as any).userOverview === undefined) task.userOverview = null;
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

			if (options?.persistMigrations) {
				log.info("Backfilled seq for tasks", { projectId: project.id });
				await rawSaveTasks(project, tasks);
			}
		}

		log.info(`Loaded ${tasks.length} task(s)`, { projectId: project.id });
		return tasks;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			log.info("No tasks file yet", { projectId: project.id });
			return [];
		}
		log.error("Failed to load tasks", { projectId: project.id, error: String(err) });
		if (options?.strict) {
			throw toDataFileReadError(file, "tasks", err);
		}
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
	await writeHourlyTasksBackup(project, file).catch((err) => {
		log.warn("Failed to write hourly tasks backup (non-fatal)", { projectId: project.id, err });
	});
	await writeFile(file, JSON.stringify(tasks, null, 2));
	log.info(`Saved ${tasks.length} task(s)`, { projectId: project.id });
}

async function writeHourlyTasksBackup(project: Project, filePath: string): Promise<void> {
	let currentContent: string;
	try {
		currentContent = await readFile(filePath, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return;
		}
		throw err;
	}

	const backupDir = tasksBackupDir(project);
	const backupFile = `${backupDir}/${tasksBackupFileName()}`;

	await mkdir(backupDir, { recursive: true });

	try {
		await readFile(backupFile, "utf8");
	} catch (err: any) {
		if (err.code !== "ENOENT") {
			throw err;
		}
		await writeFile(backupFile, currentContent);
	}

	const backupFiles = (await readdir(backupDir))
		.filter((entry) => TASK_BACKUP_FILE_PATTERN.test(entry))
		.sort();

	for (const staleFile of backupFiles.slice(0, Math.max(0, backupFiles.length - TASK_BACKUP_RETENTION_HOURS))) {
		await unlink(`${backupDir}/${staleFile}`);
	}
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
	extras?: {
		groupId?: string;
		variantIndex?: number;
		agentId?: string | null;
		configId?: string | null;
		seq?: number;
		existingBranch?: string;
		preparing?: boolean;
		preparingStage?: Task["preparingStage"];
		preparingProgress?: Task["preparingProgress"];
		watched?: boolean;
		scratch?: boolean;
	},
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		const title = titleFromDescription(description);
		log.info("Creating task", { projectId: project.id, title, status });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const now = new Date().toISOString();
		const task: Task = {
			id: crypto.randomUUID(),
			seq: extras?.seq ?? nextSeq(tasks),
			projectId: project.id,
			title,
			description,
			status,
			baseBranch: deriveTaskBaseBranch(project, extras?.existingBranch),
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
			...(extras?.preparingStage ? { preparingStage: extras.preparingStage } : {}),
			...(typeof extras?.preparingProgress === "number" ? { preparingProgress: extras.preparingProgress } : {}),
			...(extras?.watched ? { watched: true } : {}),
			...(extras?.scratch ? { scratch: true } : {}),
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
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Promise<Task> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Updating task", { taskId, updates });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) throw new Error(`Task not found: ${taskId}`);
		const updatedTask = applyTaskUpdate(tasks, idx, updates, options);
		await rawSaveTasks(project, tasks);
		return updatedTask;
	});
}

export async function updateTaskWith<T>(
	project: Project,
	taskId: string,
	mutator: (task: Task) => Promise<{ updates: Partial<Task>; result: T }> | { updates: Partial<Task>; result: T },
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Promise<{ task: Task; result: T }> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Updating task with mutator", { projectId: project.id, taskId });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx === -1) throw new Error(`Task not found: ${taskId}`);
		const { updates, result } = await mutator(tasks[idx]);
		const task = applyTaskUpdate(tasks, idx, updates, options);
		await rawSaveTasks(project, tasks);
		return { task, result };
	});
}

export async function deleteTask(
	project: Project,
	taskId: string,
): Promise<void> {
	const file = tasksFile(project);
	return withFileLock(file, async () => {
		log.info("Deleting task", { taskId, projectId: project.id });
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
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

function applyTaskUpdate(
	tasks: Task[],
	idx: number,
	updates: Partial<Task>,
	options?: {
		dropPosition?: "top" | "bottom";
		ifStatus?: string;
		ifStatusNot?: string;
	},
): Task {
	const currentTask = tasks[idx];
	const allowedStatuses = options?.ifStatus
		?.split(",")
		.map((status) => status.trim())
		.filter(Boolean);
	if (allowedStatuses && !allowedStatuses.includes(currentTask.status)) {
		return currentTask;
	}
	const blockedStatuses = options?.ifStatusNot
		?.split(",")
		.map((status) => status.trim())
		.filter(Boolean);
	if (blockedStatuses && blockedStatuses.includes(currentTask.status)) {
		return currentTask;
	}
	const now = new Date().toISOString();
	const statusChanged = updates.status && updates.status !== currentTask.status;

	if (statusChanged) {
		const newStatus = updates.status!;
		const dropPosition = options?.dropPosition;

		tasks[idx] = { ...tasks[idx], ...updates, movedAt: now, columnOrder: undefined, updatedAt: now };

		if (dropPosition) {
			const targetCustomColumnId = tasks[idx].customColumnId ?? null;
			const columnTasks = tasks
				.filter((t) => t.status === newStatus && (t.customColumnId ?? null) === targetCustomColumnId && t.id !== tasks[idx].id)
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

	return tasks[idx];
}

function isInSameRenderedColumn(task: Task, status: string, customColumnId: string | null | undefined): boolean {
	return task.status === status && (task.customColumnId ?? null) === (customColumnId ?? null);
}

// ---- Preferences ----

const PREFERENCES_FILE = `${DEV3_HOME}/preferences.json`;

interface Preferences {
	lastPickedFolder?: string;
}

async function rawLoadPreferences(): Promise<Preferences> {
	try {
		return JSON.parse(await readFile(PREFERENCES_FILE, "utf8")) as Preferences;
	} catch (err: any) {
		if (err.code === "ENOENT") return {};
		return {};
	}
}

async function rawSavePreferences(prefs: Preferences): Promise<void> {
	await ensureDir(PREFERENCES_FILE);
	await writeFile(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
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
		const tasks = await rawLoadTasks(project, { strict: true, persistMigrations: true });
		const task = tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);

		const columnStatus = task.status;
		const columnCustomColumnId = task.customColumnId ?? null;

		const columnTasks = tasks
			.filter((t) => isInSameRenderedColumn(t, columnStatus, columnCustomColumnId))
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

// ---- Update Route (persisted across app restarts for auto-update) ----

const UPDATE_ROUTE_FILE = `${DEV3_HOME}/update-route.json`;

export async function saveUpdateRoute(route: string): Promise<void> {
	await ensureDir(UPDATE_ROUTE_FILE);
	await Bun.write(UPDATE_ROUTE_FILE, route);
}

export async function loadAndClearUpdateRoute(): Promise<string | null> {
	try {
		const file = Bun.file(UPDATE_ROUTE_FILE);
		if (!(await file.exists())) return null;
		const data = await file.text();
		await unlink(UPDATE_ROUTE_FILE);
		return data || null;
	} catch {
		return null;
	}
}
