import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task, TaskStatus } from "../../shared/types";

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

// In-process async mutex that mirrors real file-lock behavior but works with mock FS.
// This validates that data.ts correctly wraps all RMW operations in withFileLock.
const lockQueues = new Map<string, Promise<void>>();

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
		// Chain on the existing queue for this file path
		const prev = lockQueues.get(filePath) ?? Promise.resolve();
		let resolve!: () => void;
		const next = new Promise<void>((r) => { resolve = r; });
		lockQueues.set(filePath, next);

		await prev;
		try {
			return await fn();
		} finally {
			resolve();
		}
	},
	FileLockTimeoutError: class extends Error {
		constructor(lockPath: string, timeout: number) {
			super(`Failed to acquire file lock "${lockPath}" within ${timeout}ms`);
			this.name = "FileLockTimeoutError";
		}
	},
}));

// Simulate realistic async file I/O with small delays to expose race conditions.
// Without locking, concurrent read-modify-write cycles will lose updates.
let mockFileStore: Record<string, string> = {};
const WRITE_DELAY_MS = 5;

beforeEach(() => {
	mockFileStore = {};
	lockQueues.clear();
	(globalThis as any).Bun = {
		file: (path: string) => ({
			exists: async () => {
				await new Promise((r) => setTimeout(r, 1));
				return path in mockFileStore;
			},
			json: async () => {
				await new Promise((r) => setTimeout(r, 1));
				return JSON.parse(mockFileStore[path]);
			},
		}),
		write: async (path: string, content: string) => {
			await new Promise((r) => setTimeout(r, WRITE_DELAY_MS));
			mockFileStore[path] = content;
		},
		spawn: (_cmd: string[]) => ({ exited: Promise.resolve(0) }),
	};
});

import {
	addTask,
	loadTasks,
	updateTask,
	deleteTask,
	addProject,
	loadProjects,
	removeProject,
} from "../data";

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

function makeTask(overrides: Partial<Task> & { id: string; seq: number }): Task {
	return {
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

// ============================================================
// Concurrent addTask — the core race condition scenario
// ============================================================

describe("concurrent addTask — no lost updates", () => {
	it("two concurrent addTask calls both persist (no lost task)", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		// Two agents adding tasks at the exact same time
		const [t1, t2] = await Promise.all([
			addTask(testProject, "Task from Agent A"),
			addTask(testProject, "Task from Agent B"),
		]);

		const tasks = await loadTasks(testProject);

		// BOTH tasks must exist — this is the critical assertion.
		// Without locking, one of them gets lost.
		expect(tasks).toHaveLength(2);
		expect(tasks.find((t) => t.id === t1.id)).toBeDefined();
		expect(tasks.find((t) => t.id === t2.id)).toBeDefined();
	});

	it("five concurrent addTask calls all persist", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const results = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				addTask(testProject, `Task ${i + 1}`),
			),
		);

		const tasks = await loadTasks(testProject);
		expect(tasks).toHaveLength(5);

		for (const result of results) {
			expect(tasks.find((t) => t.id === result.id)).toBeDefined();
		}
	});

	it("concurrent addTask assigns unique seq values", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const results = await Promise.all([
			addTask(testProject, "Task A"),
			addTask(testProject, "Task B"),
			addTask(testProject, "Task C"),
		]);

		const seqs = results.map((t) => t.seq);
		const uniqueSeqs = new Set(seqs);
		expect(uniqueSeqs.size).toBe(3);
	});
});

// ============================================================
// Concurrent addTask + updateTask
// ============================================================

describe("concurrent addTask + updateTask — no lost updates", () => {
	it("addTask and updateTask on same file do not lose data", async () => {
		const existing = [
			makeTask({ id: "existing-1", seq: 1 }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(existing);

		// One agent adds a task, another updates the existing one — simultaneously
		const [newTask] = await Promise.all([
			addTask(testProject, "Brand new task"),
			updateTask(testProject, "existing-1", { title: "Updated title" }),
		]);

		const tasks = await loadTasks(testProject);

		// Both the new task and the updated task must be present
		expect(tasks).toHaveLength(2);
		expect(tasks.find((t) => t.id === newTask.id)).toBeDefined();

		const updated = tasks.find((t) => t.id === "existing-1");
		expect(updated).toBeDefined();
		expect(updated!.title).toBe("Updated title");
	});
});

// ============================================================
// Concurrent deleteTask + addTask
// ============================================================

describe("concurrent deleteTask + addTask — no lost updates", () => {
	it("deleteTask and addTask do not interfere with each other", async () => {
		const existing = [
			makeTask({ id: "to-delete", seq: 1 }),
			makeTask({ id: "to-keep", seq: 2 }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(existing);

		const [, newTask] = await Promise.all([
			deleteTask(testProject, "to-delete"),
			addTask(testProject, "New task"),
		]);

		const tasks = await loadTasks(testProject);

		// "to-delete" should be gone, "to-keep" and new task should be present
		expect(tasks.find((t) => t.id === "to-delete")).toBeUndefined();
		expect(tasks.find((t) => t.id === "to-keep")).toBeDefined();
		expect(tasks.find((t) => t.id === newTask.id)).toBeDefined();
	});
});

// ============================================================
// Concurrent updateTask + updateTask on different tasks
// ============================================================

describe("concurrent updateTask on different tasks — no lost updates", () => {
	it("two updates to different tasks both persist", async () => {
		const existing = [
			makeTask({ id: "task-a", seq: 1, title: "Original A" }),
			makeTask({ id: "task-b", seq: 2, title: "Original B" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(existing);

		await Promise.all([
			updateTask(testProject, "task-a", { title: "Updated A" }),
			updateTask(testProject, "task-b", { title: "Updated B" }),
		]);

		const tasks = await loadTasks(testProject);
		const a = tasks.find((t) => t.id === "task-a");
		const b = tasks.find((t) => t.id === "task-b");

		expect(a!.title).toBe("Updated A");
		expect(b!.title).toBe("Updated B");
	});
});

// ============================================================
// Concurrent project operations
// ============================================================

describe("concurrent project operations — no lost updates", () => {
	it("two concurrent addProject calls both persist", async () => {
		const [p1, p2] = await Promise.all([
			addProject("/tmp/repo-a", "Repo A"),
			addProject("/tmp/repo-b", "Repo B"),
		]);

		const projects = await loadProjects();
		expect(projects).toHaveLength(2);
		expect(projects.find((p) => p.id === p1.id)).toBeDefined();
		expect(projects.find((p) => p.id === p2.id)).toBeDefined();
	});

	it("addProject and removeProject do not lose data", async () => {
		// Seed one project
		const existing = await addProject("/tmp/existing", "Existing");

		// Simultaneously add a new project and soft-delete the existing one
		const [, newProject] = await Promise.all([
			removeProject(existing.id),
			addProject("/tmp/new-one", "New One"),
		]);

		const projects = await loadProjects();

		// "existing" should be soft-deleted (filtered out by loadProjects)
		// "new-one" should be present
		expect(projects.find((p) => p.id === existing.id)).toBeUndefined();
		expect(projects.find((p) => p.id === newProject.id)).toBeDefined();
	});
});

// ============================================================
// Stress test — many concurrent operations on same file
// ============================================================

describe("stress — many concurrent writes", () => {
	it("10 concurrent addTask calls preserve all tasks", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				addTask(testProject, `Stress task ${i}`),
			),
		);

		const tasks = await loadTasks(testProject);
		expect(tasks).toHaveLength(10);

		for (const result of results) {
			expect(tasks.find((t) => t.id === result.id)).toBeDefined();
		}
	});

	it("mix of add, update, delete — all operations apply correctly", async () => {
		// Start with 3 tasks
		const seed = [
			makeTask({ id: "s1", seq: 1, title: "Seed 1" }),
			makeTask({ id: "s2", seq: 2, title: "Seed 2" }),
			makeTask({ id: "s3", seq: 3, title: "Seed 3" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(seed);

		// Concurrently: delete s1, update s2, add new task
		const [, , newTask] = await Promise.all([
			deleteTask(testProject, "s1"),
			updateTask(testProject, "s2", { title: "Updated S2" }),
			addTask(testProject, "New during chaos"),
		]);

		const tasks = await loadTasks(testProject);

		// s1 deleted
		expect(tasks.find((t) => t.id === "s1")).toBeUndefined();
		// s2 updated
		expect(tasks.find((t) => t.id === "s2")!.title).toBe("Updated S2");
		// s3 untouched
		expect(tasks.find((t) => t.id === "s3")).toBeDefined();
		// new task present
		expect(tasks.find((t) => t.id === newTask.id)).toBeDefined();
	});
});
