import type { Project, Task, TaskStatus } from "../shared/types";
import { titleFromDescription } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { DEV3_HOME } from "./paths";

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

export async function loadProjects(): Promise<Project[]> {
	log.debug("Loading projects", { file: PROJECTS_FILE });
	try {
		const file = Bun.file(PROJECTS_FILE);
		if (!(await file.exists())) {
			log.info("No projects file yet, returning empty list");
			return [];
		}
		const projects: Project[] = await file.json();
		log.info(`Loaded ${projects.length} project(s)`);
		return projects;
	} catch (err) {
		log.error("Failed to load projects", { error: String(err) });
		return [];
	}
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
	const projects = await loadProjects();
	const project: Project = {
		id: crypto.randomUUID(),
		name,
		path,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
	};
	projects.push(project);
	await saveProjects(projects);
	log.info("Project added", { id: project.id, name });
	return project;
}

export async function removeProject(projectId: string): Promise<void> {
	log.info("Removing project", { projectId });
	const projects = await loadProjects();
	const filtered = projects.filter((p) => p.id !== projectId);
	await saveProjects(filtered);
}

export async function updateProject(
	projectId: string,
	updates: Partial<Pick<Project, "setupScript" | "devScript" | "cleanupScript" | "defaultBaseBranch">>,
): Promise<Project> {
	console.log("[updateProject] updates:", JSON.stringify(updates));
	log.info("Updating project", { projectId, updates });
	const projects = await loadProjects();
	const idx = projects.findIndex((p) => p.id === projectId);
	if (idx === -1) throw new Error(`Project not found: ${projectId}`);
	projects[idx] = { ...projects[idx], ...updates };
	console.log("[updateProject] merged project:", JSON.stringify(projects[idx]));
	await saveProjects(projects);
	return projects[idx];
}

export async function getProject(projectId: string): Promise<Project> {
	const projects = await loadProjects();
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
	extras?: { groupId?: string; variantIndex?: number; agentId?: string | null; configId?: string | null; seq?: number },
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
	const movedAtUpdate = updates.status && updates.status !== tasks[idx].status ? { movedAt: now } : {};
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
