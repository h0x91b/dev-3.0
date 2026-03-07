import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

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

// Track what's written to disk
let mockFileStore: Record<string, string> = {};

// We need to mock the Bun global, not a module

beforeEach(() => {
	mockFileStore = {};
	// Patch globalThis.Bun for the data module
	(globalThis as any).Bun = {
		file: (path: string) => ({
			exists: async () => path in mockFileStore,
			json: async () => JSON.parse(mockFileStore[path]),
		}),
		write: async (path: string, content: string) => {
			mockFileStore[path] = content;
		},
		spawn: (_cmd: string[]) => ({ exited: Promise.resolve(0) }),
	};
});

import { loadTasks, addTask, updateTask } from "../data";

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function tasksFilePath(): string {
	return "/tmp/dev3-test/data/tmp-test-project/tasks.json";
}

function makeRawTask(overrides: Partial<Task> & { id: string }): Record<string, unknown> {
	return {
		projectId: "proj-1",
		title: "Task",
		description: "desc",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

// ============================================================
// Backfill tests
// ============================================================

describe("loadTasks — seq backfill", () => {
	it("assigns sequential seq to tasks without seq field", async () => {
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
			makeRawTask({ id: "c" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const result = await loadTasks(testProject);

		expect(result).toHaveLength(3);
		expect(result[0].seq).toBe(1);
		expect(result[1].seq).toBe(2);
		expect(result[2].seq).toBe(3);
	});

	it("respects existing seq values (starts from max+1)", async () => {
		const tasks = [
			makeRawTask({ id: "a", seq: 5 } as any),
			makeRawTask({ id: "b" }), // no seq
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const result = await loadTasks(testProject);

		expect(result[0].seq).toBe(5);
		expect(result[1].seq).toBe(6);
	});

	it("assigns same seq to tasks sharing groupId", async () => {
		const tasks = [
			makeRawTask({ id: "a", groupId: "g1", variantIndex: 1 }),
			makeRawTask({ id: "b", groupId: "g1", variantIndex: 2 }),
			makeRawTask({ id: "c" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const result = await loadTasks(testProject);

		// a and b share groupId → same seq
		expect(result[0].seq).toBe(result[1].seq);
		// c gets a different seq
		expect(result[2].seq).not.toBe(result[0].seq);
	});

	it("persists backfilled seq to disk", async () => {
		const tasks = [makeRawTask({ id: "a" })];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		await loadTasks(testProject);

		// File should be updated
		const saved = JSON.parse(mockFileStore[tasksFilePath()]);
		expect(saved[0].seq).toBe(1);
	});

	it("second load returns same seq values (no re-backfill)", async () => {
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const first = await loadTasks(testProject);
		const second = await loadTasks(testProject);

		expect(first[0].seq).toBe(second[0].seq);
		expect(first[1].seq).toBe(second[1].seq);
	});

	it("handles mix of tasks with and without seq", async () => {
		const tasks = [
			makeRawTask({ id: "a", seq: 3 } as any),
			makeRawTask({ id: "b" }), // no seq
			makeRawTask({ id: "c", seq: 1 } as any),
			makeRawTask({ id: "d" }), // no seq
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const result = await loadTasks(testProject);

		expect(result[0].seq).toBe(3); // kept
		expect(result[2].seq).toBe(1); // kept
		expect(result[1].seq).toBe(4); // backfilled from max(3)+1
		expect(result[3].seq).toBe(5); // backfilled
	});

	it("handles empty task list (no crash)", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const result = await loadTasks(testProject);
		expect(result).toHaveLength(0);
	});

	it("handles no tasks file", async () => {
		// No file in store
		const result = await loadTasks(testProject);
		expect(result).toHaveLength(0);
	});
});

// ============================================================
// addTask seq tests
// ============================================================

describe("addTask — seq assignment", () => {
	it("new task gets auto-incremented seq", async () => {
		// Seed with one existing task
		const existing = [{ ...makeRawTask({ id: "a" }), seq: 3 }];
		mockFileStore[tasksFilePath()] = JSON.stringify(existing);

		const task = await addTask(testProject, "New task");

		expect(task.seq).toBe(4);
	});

	it("explicit seq in extras is respected", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const task = await addTask(testProject, "New task", "todo", { seq: 42 });

		expect(task.seq).toBe(42);
	});

	it("first task in empty project gets seq 1", async () => {
		// No tasks file → empty list
		const task = await addTask(testProject, "First task");

		expect(task.seq).toBe(1);
	});

	it("multiple sequential addTask calls produce unique seq values", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const t1 = await addTask(testProject, "Task 1");
		const t2 = await addTask(testProject, "Task 2");
		const t3 = await addTask(testProject, "Task 3");

		expect(t1.seq).toBe(1);
		expect(t2.seq).toBe(2);
		expect(t3.seq).toBe(3);
	});

	it("addTask persists existingBranch and loadTasks reads it back", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const task = await addTask(testProject, "Continue on branch", "todo", { existingBranch: "feature/login" });
		expect(task.existingBranch).toBe("feature/login");

		// Read back from disk
		const loaded = await loadTasks(testProject);
		expect(loaded[0].existingBranch).toBe("feature/login");
	});

	it("addTask without existingBranch does not set the field", async () => {
		mockFileStore[tasksFilePath()] = JSON.stringify([]);

		const task = await addTask(testProject, "Normal task");
		expect(task.existingBranch).toBeUndefined();

		const loaded = await loadTasks(testProject);
		expect(loaded[0].existingBranch).toBeUndefined();
	});

	it("addTask after backfill continues from correct seq", async () => {
		// Old tasks without seq
		const tasks = [
			makeRawTask({ id: "a" }),
			makeRawTask({ id: "b" }),
		];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		// loadTasks triggers backfill: a=1, b=2
		await loadTasks(testProject);

		// New task should get seq=3
		const newTask = await addTask(testProject, "New task");
		expect(newTask.seq).toBe(3);
	});
});

// ============================================================
// updateTask — columnOrder reset on status change
// ============================================================

describe("updateTask — clears columnOrder on status change", () => {
	it("clears columnOrder when status changes", async () => {
		const tasks = [{ ...makeRawTask({ id: "t1", status: "in-progress" as const }), seq: 1, columnOrder: 3, labelIds: [] }];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const updated = await updateTask(testProject, "t1", { status: "completed" });

		expect(updated.columnOrder).toBeUndefined();
		expect(updated.movedAt).toBeDefined();
	});

	it("preserves columnOrder when status does not change", async () => {
		const tasks = [{ ...makeRawTask({ id: "t1", status: "in-progress" as const }), seq: 1, columnOrder: 3, labelIds: [] }];
		mockFileStore[tasksFilePath()] = JSON.stringify(tasks);

		const updated = await updateTask(testProject, "t1", { title: "Updated title" });

		expect(updated.columnOrder).toBe(3);
		expect(updated.movedAt).toBeUndefined();
	});
});
