import { Utils } from "electrobun/bun";
import type { Project, Task } from "../shared/types";

const PROJECTS_FILE = `${Utils.paths.userData}/projects.json`;

function tasksFile(project: Project): string {
	return `${project.path}/.dev3/tasks.json`;
}

// ---- Projects ----

export async function loadProjects(): Promise<Project[]> {
	try {
		const file = Bun.file(PROJECTS_FILE);
		if (!(await file.exists())) return [];
		return await file.json();
	} catch {
		return [];
	}
}

export async function saveProjects(projects: Project[]): Promise<void> {
	await Bun.write(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

export async function addProject(
	path: string,
	name: string,
): Promise<Project> {
	const projects = await loadProjects();
	const project: Project = {
		id: crypto.randomUUID(),
		name,
		path,
		setupScript: "",
		defaultTmuxCommand: "claude",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
	};
	projects.push(project);
	await saveProjects(projects);
	return project;
}

export async function removeProject(projectId: string): Promise<void> {
	const projects = await loadProjects();
	const filtered = projects.filter((p) => p.id !== projectId);
	await saveProjects(filtered);
}

export async function updateProject(
	projectId: string,
	updates: Partial<Pick<Project, "setupScript" | "defaultTmuxCommand" | "defaultBaseBranch">>,
): Promise<Project> {
	const projects = await loadProjects();
	const idx = projects.findIndex((p) => p.id === projectId);
	if (idx === -1) throw new Error(`Project not found: ${projectId}`);
	projects[idx] = { ...projects[idx], ...updates };
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

export async function loadTasks(project: Project): Promise<Task[]> {
	try {
		const file = Bun.file(tasksFile(project));
		if (!(await file.exists())) return [];
		return await file.json();
	} catch {
		return [];
	}
}

export async function saveTasks(
	project: Project,
	tasks: Task[],
): Promise<void> {
	const dir = `${project.path}/.dev3`;
	const proc = Bun.spawn(["mkdir", "-p", dir]);
	await proc.exited;
	await Bun.write(tasksFile(project), JSON.stringify(tasks, null, 2));
}

export async function addTask(
	project: Project,
	title: string,
): Promise<Task> {
	const tasks = await loadTasks(project);
	const now = new Date().toISOString();
	const task: Task = {
		id: crypto.randomUUID(),
		projectId: project.id,
		title,
		status: "todo",
		baseBranch: project.defaultBaseBranch,
		worktreePath: null,
		branchName: null,
		createdAt: now,
		updatedAt: now,
	};
	tasks.push(task);
	await saveTasks(project, tasks);
	return task;
}

export async function updateTask(
	project: Project,
	taskId: string,
	updates: Partial<Task>,
): Promise<Task> {
	const tasks = await loadTasks(project);
	const idx = tasks.findIndex((t) => t.id === taskId);
	if (idx === -1) throw new Error(`Task not found: ${taskId}`);
	tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
	await saveTasks(project, tasks);
	return tasks[idx];
}

export async function deleteTask(
	project: Project,
	taskId: string,
): Promise<void> {
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
