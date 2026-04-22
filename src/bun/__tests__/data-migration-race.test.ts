import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, TaskStatus } from "../../shared/types";

const { mockFileStore, lockQueues, fsPromises } = vi.hoisted(() => ({
	mockFileStore: {} as Record<string, string>,
	lockQueues: new Map<string, Promise<void>>(),
	fsPromises: {
		mkdir: vi.fn(),
		readFile: vi.fn(),
		readdir: vi.fn(),
		unlink: vi.fn(),
		writeFile: vi.fn(),
	},
}));

vi.mock("node:fs/promises", () => fsPromises);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test",
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
		const prev = lockQueues.get(filePath) ?? Promise.resolve();
		let resolve!: () => void;
		const next = new Promise<void>((r) => {
			resolve = r;
		});
		lockQueues.set(filePath, next);

		await prev;
		try {
			return await fn();
		} finally {
			resolve();
		}
	},
}));

import { addProject, addTask, loadProjects, loadTasks } from "../data";

const PROJECTS_FILE = "/tmp/dev3-test/projects.json";
const WRITE_DELAY_MS = 5;

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [],
};

function tasksFilePath(): string {
	return "/tmp/dev3-test/data/tmp-test-project/tasks.json";
}

function makeTask(overrides: Partial<Task> & { id: string; seq?: number }): Task {
	return {
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "desc",
		status: "todo" as TaskStatus,
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		labelIds: [],
		...overrides,
	};
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	for (const key of Object.keys(mockFileStore)) {
		delete mockFileStore[key];
	}
	lockQueues.clear();
	fsPromises.mkdir.mockResolvedValue(undefined);
	fsPromises.readdir.mockImplementation(async (dirPath: string | URL | Buffer) => {
		const prefix = `${String(dirPath)}/`;
		return Object.keys(mockFileStore)
			.filter((path) => path.startsWith(prefix))
			.map((path) => path.slice(prefix.length))
			.filter((entry) => !entry.includes("/"))
			.sort();
	});
	fsPromises.unlink.mockImplementation(async (path: string | URL | Buffer) => {
		delete mockFileStore[String(path)];
	});
	fsPromises.readFile.mockImplementation(async (path: string | URL | Buffer) => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		const key = String(path);
		if (!(key in mockFileStore)) {
			const err = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		}
		return mockFileStore[key];
	});
	fsPromises.writeFile.mockImplementation(async (path: string | URL | Buffer, content: string | ArrayBuffer | SharedArrayBuffer | DataView) => {
		await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
		mockFileStore[String(path)] = String(content);
	});
});

describe("migration readers racing with writers", () => {
	it("loadProjects backfill does not clobber a concurrent addProject", async () => {
		mockFileStore[PROJECTS_FILE] = JSON.stringify([
			{
				id: "legacy-project",
				name: "Legacy",
				path: "/tmp/legacy",
				setupScript: "",
				devScript: "",
				cleanupScript: "say done",
				defaultBaseBranch: "main",
				createdAt: "2025-01-01T00:00:00Z",
				labels: [],
			},
		]);

		const firstReaderWrite = defer();
		const releaseReaderWrite = defer();
		const originalWrite = fsPromises.writeFile.getMockImplementation()!;
		let mutatorStarted = false;

		fsPromises.writeFile.mockImplementation(async (path: string | URL | Buffer, content: string | ArrayBuffer | SharedArrayBuffer | DataView) => {
			const key = String(path);
			const text = String(content);
			if (!mutatorStarted && key === PROJECTS_FILE && text.includes('"cleanupScript": ""')) {
				firstReaderWrite.resolve();
				await releaseReaderWrite.promise;
			}
			return originalWrite(path, content);
		});

		const migratingLoad = loadProjects();
		const writeOutcome = await Promise.race([
			firstReaderWrite.promise.then(() => "write" as const),
			new Promise<"no-write">((resolve) => setTimeout(() => resolve("no-write"), 20)),
		]);

		mutatorStarted = true;
		const addedProject = await addProject("/tmp/new-project", "New Project");
		if (writeOutcome === "write") {
			releaseReaderWrite.resolve();
		}
		await migratingLoad;

		const projects = await loadProjects();
		expect(writeOutcome).toBe("no-write");
		expect(projects.find((project) => project.id === addedProject.id)).toBeDefined();
	});

	it("loadTasks seq backfill does not clobber a concurrent addTask", async () => {
		const tasksPath = tasksFilePath();
		mockFileStore[tasksPath] = JSON.stringify([
			makeTask({ id: "legacy-task", seq: undefined }),
		]);

		const firstReaderWrite = defer();
		const releaseReaderWrite = defer();
		const originalWrite = fsPromises.writeFile.getMockImplementation()!;
		let mutatorStarted = false;

		fsPromises.writeFile.mockImplementation(async (path: string | URL | Buffer, content: string | ArrayBuffer | SharedArrayBuffer | DataView) => {
			const key = String(path);
			const text = String(content);
			if (!mutatorStarted && key === tasksPath && text.includes('"seq": 1')) {
				firstReaderWrite.resolve();
				await releaseReaderWrite.promise;
			}
			return originalWrite(path, content);
		});

		const migratingLoad = loadTasks(testProject);
		const writeOutcome = await Promise.race([
			firstReaderWrite.promise.then(() => "write" as const),
			new Promise<"no-write">((resolve) => setTimeout(() => resolve("no-write"), 20)),
		]);

		mutatorStarted = true;
		const addedTask = await addTask(testProject, "Task created during migration");
		if (writeOutcome === "write") {
			releaseReaderWrite.resolve();
		}
		await migratingLoad;

		const tasks = await loadTasks(testProject);
		expect(writeOutcome).toBe("no-write");
		expect(tasks.find((task) => task.id === addedTask.id)).toBeDefined();
	});
});
