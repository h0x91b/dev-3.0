import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

const { logDebug } = vi.hoisted(() => ({ logDebug: vi.fn() }));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: logDebug,
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test-data-cache",
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { _resetDataCaches, loadProjects, loadTasks, saveTasks } from "../data";

const HOME = "/tmp/dev3-test-data-cache";
const PROJECT_PATH = "/tmp/dev3-cache-project";
const SLUG = "tmp-dev3-cache-project";

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "p1",
		path: PROJECT_PATH,
		name: "cache-project",
		defaultBaseBranch: "main",
		labels: [],
		customColumns: [],
		...overrides,
	} as Project;
}

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "task one",
		description: "task one",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		labelIds: [],
		notes: [],
		customTitle: null,
		titleEditedByUser: false,
		customColumnId: null,
		overview: null,
		userOverview: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		tmuxSocket: "dev3",
		...overrides,
	} as Task;
}

function writeTasksFile(tasks: Task[]): void {
	mkdirSync(`${HOME}/data/${SLUG}`, { recursive: true });
	writeFileSync(`${HOME}/data/${SLUG}/tasks.json`, JSON.stringify(tasks, null, 2));
}

function writeProjectsFile(projects: Project[]): void {
	mkdirSync(HOME, { recursive: true });
	writeFileSync(`${HOME}/projects.json`, JSON.stringify(projects, null, 2));
}

function loadingTasksLogCount(): number {
	return logDebug.mock.calls.filter(([msg]) => msg === "Loading tasks").length;
}

function loadingProjectsLogCount(): number {
	return logDebug.mock.calls.filter(([msg]) => msg === "Loading all projects").length;
}

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(HOME, { recursive: true });
	_resetDataCaches();
	logDebug.mockClear();
});

describe("tasks read cache", () => {
	it("serves repeated loads from cache without re-reading the file", async () => {
		const project = makeProject();
		writeTasksFile([makeTask()]);

		const first = await loadTasks(project);
		expect(first).toHaveLength(1);
		expect(loadingTasksLogCount()).toBe(1);

		const second = await loadTasks(project);
		expect(second).toHaveLength(1);
		expect(second[0].id).toBe("t1");
		// Cache hit: no second disk read.
		expect(loadingTasksLogCount()).toBe(1);
	});

	it("cache hits return independent copies", async () => {
		const project = makeProject();
		writeTasksFile([makeTask()]);

		const first = await loadTasks(project);
		const second = await loadTasks(project);
		expect(second).not.toBe(first);
		expect(second[0]).not.toBe(first[0]);

		first[0].title = "mutated";
		first.push(makeTask({ id: "phantom" }));
		const third = await loadTasks(project);
		expect(third).toHaveLength(1);
		expect(third[0].title).toBe("task one");
	});

	it("re-reads after saveTasks invalidates the cache", async () => {
		const project = makeProject();
		writeTasksFile([makeTask()]);

		await loadTasks(project);
		await saveTasks(project, [makeTask(), makeTask({ id: "t2", seq: 2 })]);

		const reloaded = await loadTasks(project);
		expect(reloaded).toHaveLength(2);
	});

	it("re-reads after an external write changes the file", async () => {
		const project = makeProject();
		writeTasksFile([makeTask()]);

		await loadTasks(project);
		writeTasksFile([makeTask(), makeTask({ id: "t2", seq: 2 }), makeTask({ id: "t3", seq: 3 })]);
		// Force a distinct mtime in case writes land within the same clock tick.
		utimesSync(`${HOME}/data/${SLUG}/tasks.json`, new Date(), new Date(Date.now() + 5000));

		const reloaded = await loadTasks(project);
		expect(reloaded).toHaveLength(3);
	});

	it("still returns empty list when tasks file is missing", async () => {
		const project = makeProject();
		const tasks = await loadTasks(project);
		expect(tasks).toEqual([]);
	});
});

describe("projects read cache", () => {
	it("serves repeated loads from cache and re-reads after external change", async () => {
		writeProjectsFile([makeProject()]);

		const first = await loadProjects();
		expect(first).toHaveLength(1);
		expect(loadingProjectsLogCount()).toBe(1);

		const second = await loadProjects();
		expect(second).toHaveLength(1);
		expect(loadingProjectsLogCount()).toBe(1);

		writeProjectsFile([makeProject(), makeProject({ id: "p2", path: "/tmp/dev3-cache-project-2" })]);
		utimesSync(`${HOME}/projects.json`, new Date(), new Date(Date.now() + 5000));
		const third = await loadProjects();
		expect(third).toHaveLength(2);
	});

	it("cache hits return independent project copies", async () => {
		writeProjectsFile([makeProject()]);

		const first = await loadProjects();
		first[0].name = "mutated";
		const second = await loadProjects();
		expect(second[0].name).toBe("cache-project");
	});
});
