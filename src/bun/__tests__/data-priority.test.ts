import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task, TaskStatus } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-priority`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { addTask, loadTasks, setTaskPriority, updateTask } from "../data";

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
	return `${TEST_HOME}/data/tmp-test-project/tasks.json`;
}

function makeTask(overrides: Partial<Task> & { id: string; seq: number }): Task {
	return {
		projectId: "proj-1",
		title: "Task",
		description: "desc",
		status: "todo" as TaskStatus,
		priority: "P2",
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

function seedTasks(tasks: Array<Task | Record<string, unknown>>): void {
	mkdirSync(dirname(tasksFilePath()), { recursive: true });
	writeFileSync(tasksFilePath(), JSON.stringify(tasks));
}

function readSavedTasks(): Task[] {
	return JSON.parse(readFileSync(tasksFilePath(), "utf8"));
}

// ============================================================
// Load migration — stamp P3 in place and persist
// ============================================================

describe("priority load migration", () => {
	it("stamps the default onto tasks missing the field and persists it", async () => {
		// Raw shape from an older app version: no `priority` key.
		seedTasks([
			{ id: "A", seq: 1, projectId: "proj-1", title: "Old", description: "d", status: "todo", baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null, agentId: null, configId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", labelIds: [] },
		]);

		// A mutator read (persistMigrations) runs the migration and rewrites the file.
		await setTaskPriority(testProject, "A", "P3"); // no-op on value, but triggers a mutator read
		const saved = readSavedTasks();
		expect(saved[0].priority).toBe("P3");
	});

	it("new tasks are created with P3 by default", async () => {
		const task = await addTask(testProject, "Fresh task");
		expect(task.priority).toBe("P3");
		expect(readSavedTasks()[0].priority).toBe("P3");
	});

	it("addTask honors an explicit priority", async () => {
		const task = await addTask(testProject, "Urgent", "todo", { priority: "P0" });
		expect(task.priority).toBe("P0");
	});
});

// ============================================================
// setTaskPriority — one task, never its variant siblings
// ============================================================

describe("setTaskPriority", () => {
	it("writes only the target variant; live and finished siblings keep their priority", async () => {
		seedTasks([
			makeTask({ id: "g-v1", seq: 1, groupId: "g1", variantIndex: 1, priority: "P2", status: "review-by-user" }),
			makeTask({ id: "g-v2", seq: 1, groupId: "g1", variantIndex: 2, priority: "P2", status: "in-progress" }),
			makeTask({ id: "g-v3", seq: 1, groupId: "g1", variantIndex: 3, priority: "P2", status: "completed" }),
			makeTask({ id: "g-v4", seq: 1, groupId: "g1", variantIndex: 4, priority: "P2", status: "cancelled" }),
		]);

		const changed = await setTaskPriority(testProject, "g-v1", "P0");

		expect(changed.map((t) => t.id)).toEqual(["g-v1"]);
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "g-v1")!.priority).toBe("P0");
		for (const id of ["g-v2", "g-v3", "g-v4"]) {
			const sibling = saved.find((t) => t.id === id)!;
			expect(sibling.priority).toBe("P2");
			expect(sibling.updatedAt).toBe("2025-01-01T00:00:00Z");
		}
	});

	it("keeps diverged sibling priorities across a reload and a second write", async () => {
		seedTasks([
			makeTask({ id: "g-v1", seq: 1, groupId: "g1", variantIndex: 1, priority: "P3" }),
			makeTask({ id: "g-v2", seq: 1, groupId: "g1", variantIndex: 2, priority: "P3" }),
		]);
		await setTaskPriority(testProject, "g-v1", "P1");
		await setTaskPriority(testProject, "g-v2", "P4");

		const reloaded = await loadTasks(testProject);
		expect(reloaded.find((t) => t.id === "g-v1")!.priority).toBe("P1");
		expect(reloaded.find((t) => t.id === "g-v2")!.priority).toBe("P4");
	});

	it("only writes the single task when it has no group", async () => {
		seedTasks([
			makeTask({ id: "a", seq: 1, priority: "P2" }),
			makeTask({ id: "b", seq: 2, priority: "P2" }),
		]);
		const changed = await setTaskPriority(testProject, "a", "P1");
		expect(changed.map((t) => t.id)).toEqual(["a"]);
		expect(readSavedTasks().find((t) => t.id === "b")!.priority).toBe("P2");
	});

	it("returns nothing changed when the value already matches", async () => {
		seedTasks([makeTask({ id: "a", seq: 1, priority: "P3" })]);
		const changed = await setTaskPriority(testProject, "a", "P3");
		expect(changed).toEqual([]);
	});
});

// ============================================================
// Column moves never touch priority
// ============================================================

/**
 * Priority is set deliberately (badge menu, inspector, `dev3 task update
 * --priority`) and must survive every column move. It used to not: vertical
 * drag inside a column re-prioritized a card to the band it landed in
 * (`reorderTasksInColumn`, removed together with the drag). Every column move
 * funnels through `updateTask`, so guarding it here covers the board, the
 * sidebar, the CLI and the lifecycle machine at once.
 */
describe("column moves preserve priority", () => {
	it("keeps the priority when the built-in status changes", async () => {
		seedTasks([makeTask({ id: "a", seq: 1, priority: "P0" })]);
		const moved = await updateTask(testProject, "a", { status: "in-progress" });
		expect(moved.priority).toBe("P0");
		expect(readSavedTasks()[0].priority).toBe("P0");
	});

	it("keeps the priority when the task moves into a custom column", async () => {
		seedTasks([makeTask({ id: "a", seq: 1, priority: "P1" })]);
		const moved = await updateTask(testProject, "a", { customColumnId: "col-hold" });
		expect(moved.customColumnId).toBe("col-hold");
		expect(moved.priority).toBe("P1");
	});

	it("keeps the priority when the task leaves a custom column", async () => {
		seedTasks([makeTask({ id: "a", seq: 1, priority: "P4", customColumnId: "col-hold" })]);
		const moved = await updateTask(testProject, "a", { customColumnId: null });
		expect(moved.customColumnId).toBeNull();
		expect(moved.priority).toBe("P4");
	});

	it("keeps the priority on a terminal move", async () => {
		seedTasks([makeTask({ id: "a", seq: 1, priority: "P0" })]);
		const moved = await updateTask(testProject, "a", { status: "completed" });
		expect(moved.priority).toBe("P0");
	});

	it("leaves the rest of a variant group's priority alone when one member moves", async () => {
		seedTasks([
			makeTask({ id: "v1", seq: 1, groupId: "g1", variantIndex: 1, priority: "P1" }),
			makeTask({ id: "v2", seq: 1, groupId: "g1", variantIndex: 2, priority: "P1" }),
		]);
		await updateTask(testProject, "v1", { status: "review-by-user" });
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "v1")!.priority).toBe("P1");
		expect(saved.find((t) => t.id === "v2")!.priority).toBe("P1");
	});
});
