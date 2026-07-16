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

import { addTask, setTaskPriority, reorderTasksInColumn } from "../data";

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
// setTaskPriority — group-wide write
// ============================================================

describe("setTaskPriority", () => {
	it("writes the priority to every task in the variant group", async () => {
		seedTasks([
			makeTask({ id: "g-v1", seq: 1, groupId: "g1", variantIndex: 1, priority: "P2" }),
			makeTask({ id: "g-v2", seq: 1, groupId: "g1", variantIndex: 2, priority: "P2" }),
			makeTask({ id: "solo", seq: 2, priority: "P2" }),
		]);

		const changed = await setTaskPriority(testProject, "g-v1", "P0");

		expect(new Set(changed.map((t) => t.id))).toEqual(new Set(["g-v1", "g-v2"]));
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "g-v1")!.priority).toBe("P0");
		expect(saved.find((t) => t.id === "g-v2")!.priority).toBe("P0");
		// A task outside the group is untouched.
		expect(saved.find((t) => t.id === "solo")!.priority).toBe("P2");
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
// reorderTasksInColumn — drag re-prioritization
// ============================================================

describe("reorderTasksInColumn — drag re-prioritization", () => {
	// Column, band-sorted (P0 on top): p0(idx0), then p2a(idx1), p2b(idx2).
	function seedBandColumn(): void {
		seedTasks([
			makeTask({ id: "p0", seq: 1, status: "in-progress", priority: "P0", columnOrder: 0 }),
			makeTask({ id: "p2a", seq: 2, status: "in-progress", priority: "P2", columnOrder: 1 }),
			makeTask({ id: "p2b", seq: 3, status: "in-progress", priority: "P2", columnOrder: 2 }),
		]);
	}

	it("dropping a P2 card at the very top adopts the top (P0) band", async () => {
		seedBandColumn();
		// Drop p2b at index 0 (above p0) → neighbor-below is p0 → adopt P0.
		await reorderTasksInColumn(testProject, "p2b", 0);
		expect(readSavedTasks().find((t) => t.id === "p2b")!.priority).toBe("P0");
	});

	it("a same-band reorder never mutates priority", async () => {
		seedBandColumn();
		// Move p2b above p2a but still within the P2 band (index 1, below p0).
		await reorderTasksInColumn(testProject, "p2b", 1);
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "p2b")!.priority).toBe("P2");
		expect(saved.find((t) => t.id === "p2a")!.priority).toBe("P2");
	});

	it("dropping a P0 card into the P2 band re-prioritizes it to P2", async () => {
		seedBandColumn();
		// Drop p0 at the bottom (index 2, after both P2s) → neighbor-above is a P2 → adopt P2.
		await reorderTasksInColumn(testProject, "p0", 2);
		expect(readSavedTasks().find((t) => t.id === "p0")!.priority).toBe("P2");
	});

	it("re-prioritizes the whole variant group on a cross-band drop", async () => {
		seedTasks([
			makeTask({ id: "p0", seq: 1, status: "in-progress", priority: "P0", columnOrder: 0 }),
			makeTask({ id: "g1", seq: 2, status: "in-progress", groupId: "grp", variantIndex: 1, priority: "P2", columnOrder: 1 }),
			makeTask({ id: "g2", seq: 2, status: "in-progress", groupId: "grp", variantIndex: 2, priority: "P2", columnOrder: 2 }),
		]);
		// Drag the group to the very top → both members adopt P0.
		await reorderTasksInColumn(testProject, "g1", 0);
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "g1")!.priority).toBe("P0");
		expect(saved.find((t) => t.id === "g2")!.priority).toBe("P0");
	});

	it("keeps priority when the column has no other tasks", async () => {
		seedTasks([makeTask({ id: "only", seq: 1, status: "in-progress", priority: "P3", columnOrder: 0 })]);
		await reorderTasksInColumn(testProject, "only", 0);
		expect(readSavedTasks().find((t) => t.id === "only")!.priority).toBe("P3");
	});
});
