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

let mockFileStore: Record<string, string> = {};

beforeEach(() => {
	mockFileStore = {};
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

import { loadTasks, addTask, updateTask, reorderTasksInColumn } from "../data";

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

function seedTasks(tasks: Task[]): void {
	mockFileStore[tasksFilePath()] = JSON.stringify(tasks);
}

function readSavedTasks(): Task[] {
	return JSON.parse(mockFileStore[tasksFilePath()]);
}

// ============================================================
// reorderTasksInColumn — basic reorder
// ============================================================

describe("reorderTasksInColumn — basic reorder", () => {
	it("assigns sequential columnOrder starting from 0", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "C", 0);

		expect(result.map((t) => t.id)).toEqual(["C", "A", "B"]);
		expect(result[0].columnOrder).toBe(0);
		expect(result[1].columnOrder).toBe(1);
		expect(result[2].columnOrder).toBe(2);
	});

	it("moves task to end", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "A", 2);

		expect(result.map((t) => t.id)).toEqual(["B", "C", "A"]);
	});

	it("moves task to middle", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "C", 1);

		expect(result.map((t) => t.id)).toEqual(["A", "C", "B"]);
	});

	it("clamps negative targetIndex to 0", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "B", -5);

		expect(result.map((t) => t.id)).toEqual(["B", "A"]);
	});

	it("clamps targetIndex beyond length", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "A", 100);

		expect(result.map((t) => t.id)).toEqual(["B", "A"]);
	});

	it("no-op when task is already at target position", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "A", 0);

		expect(result.map((t) => t.id)).toEqual(["A", "B", "C"]);
	});
});

// ============================================================
// reorderTasksInColumn — persists to disk
// ============================================================

describe("reorderTasksInColumn — disk persistence", () => {
	it("persists columnOrder to disk for all tasks in column", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		await reorderTasksInColumn(testProject, "C", 0);

		const saved = readSavedTasks();
		// All three tasks should have columnOrder
		const todoTasks = saved.filter((t) => t.status === "todo");
		expect(todoTasks.every((t) => t.columnOrder !== undefined)).toBe(true);
	});

	it("persisted order survives load-save-load roundtrip", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Reorder: C to front
		await reorderTasksInColumn(testProject, "C", 0);

		// Load tasks back from disk
		const loaded = await loadTasks(testProject);
		const todoTasks = loaded
			.filter((t) => t.status === "todo")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));

		expect(todoTasks.map((t) => t.id)).toEqual(["C", "A", "B"]);
	});

	it("does not modify tasks in other columns", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "X", seq: 3, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 5 }),
		];
		seedTasks(tasks);

		await reorderTasksInColumn(testProject, "B", 0);

		const saved = readSavedTasks();
		const xTask = saved.find((t) => t.id === "X")!;
		expect(xTask.columnOrder).toBe(5); // unchanged
	});
});

// ============================================================
// reorderTasksInColumn — respects existing columnOrder
// ============================================================

describe("reorderTasksInColumn — respects existing columnOrder", () => {
	it("uses existing columnOrder as initial sort, not createdAt", async () => {
		// Tasks have columnOrder that differs from createdAt order
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 2 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z", columnOrder: 1 }),
		];
		seedTasks(tasks);

		// Initial order by columnOrder: B(0), C(1), A(2)
		// Move A to position 0 → [A, B, C]
		const result = await reorderTasksInColumn(testProject, "A", 0);

		expect(result.map((t) => t.id)).toEqual(["A", "B", "C"]);
	});

	it("re-reorder works correctly (sequential reorders)", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// First reorder: C to front → [C, A, B]
		await reorderTasksInColumn(testProject, "C", 0);

		// Second reorder: B to front → [B, C, A]
		const result = await reorderTasksInColumn(testProject, "B", 0);

		expect(result.map((t) => t.id)).toEqual(["B", "C", "A"]);
	});

	it("three sequential reorders preserve correct state", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "D", seq: 4, status: "todo", createdAt: "2025-01-04T00:00:00Z" }),
		];
		seedTasks(tasks);

		// [A, B, C, D] → move D to 0 → [D, A, B, C]
		await reorderTasksInColumn(testProject, "D", 0);
		// [D, A, B, C] → move B to 1 → [D, B, A, C]
		await reorderTasksInColumn(testProject, "B", 1);
		// [D, B, A, C] → move C to 2 → [D, B, C, A]
		const result = await reorderTasksInColumn(testProject, "C", 2);

		expect(result.map((t) => t.id)).toEqual(["D", "B", "C", "A"]);
	});
});

// ============================================================
// reorderTasksInColumn — variant groups
// ============================================================

describe("reorderTasksInColumn — variant group reorder", () => {
	it("moves entire variant group as a unit", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "G1", seq: 2, status: "todo", groupId: "grp", variantIndex: 0, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "G2", seq: 2, status: "todo", groupId: "grp", variantIndex: 1, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "B", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move group (via G1) to position 0 → [G1, G2, A, B]
		const result = await reorderTasksInColumn(testProject, "G1", 0);

		expect(result.map((t) => t.id)).toEqual(["G1", "G2", "A", "B"]);
		expect(result[0].columnOrder).toBe(0);
		expect(result[1].columnOrder).toBe(1);
	});

	it("moves group to end", async () => {
		const tasks = [
			makeTask({ id: "G1", seq: 1, status: "todo", groupId: "grp", variantIndex: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "G2", seq: 1, status: "todo", groupId: "grp", variantIndex: 1, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "A", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "B", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move group to end (after removing group, remaining has 2 items, so targetIndex=2)
		const result = await reorderTasksInColumn(testProject, "G1", 2);

		expect(result.map((t) => t.id)).toEqual(["A", "B", "G1", "G2"]);
	});
});

// ============================================================
// reorderTasksInColumn — mixed columnOrder and no columnOrder
// ============================================================

describe("reorderTasksInColumn — mixed tasks with/without columnOrder", () => {
	it("tasks without columnOrder sort after tasks with columnOrder (by createdAt)", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			// C was just moved into this column — no columnOrder
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z", movedAt: "2026-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Backend initial sort: A(col 0), B(col 1), C(no col, by createdAt → last)
		// Move C to position 0 → [C, A, B]
		const result = await reorderTasksInColumn(testProject, "C", 0);

		expect(result.map((t) => t.id)).toEqual(["C", "A", "B"]);
		expect(result[0].columnOrder).toBe(0);
		expect(result[1].columnOrder).toBe(1);
		expect(result[2].columnOrder).toBe(2);
	});

	it("newly moved task gets columnOrder after reorder", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-06-01T00:00:00Z" }), // no columnOrder
		];
		seedTasks(tasks);

		await reorderTasksInColumn(testProject, "B", 0);

		const saved = readSavedTasks();
		const bTask = saved.find((t) => t.id === "B")!;
		expect(bTask.columnOrder).toBe(0);
	});
});

// ============================================================
// Cross-column move + reorder interaction (the main suspect)
// ============================================================

describe("updateTask + reorder — cross-column then within-column", () => {
	it("cross-column move with dropPosition=top assigns columnOrder 0", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 2 }),
		];
		seedTasks(tasks);

		const updated = await updateTask(testProject, "A", { status: "in-progress" }, { dropPosition: "top" });

		// Only task in target column → columnOrder 0
		expect(updated.columnOrder).toBe(0);
		expect(updated.movedAt).toBeDefined();
	});

	it("cross-column move with dropPosition assigns columnOrder, subsequent reorder works", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "in-progress", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move C from todo to in-progress with dropPosition=top
		const updated = await updateTask(testProject, "C", { status: "in-progress" }, { dropPosition: "top" });
		expect(updated.columnOrder).toBe(0);

		// Now reorder B to position 0 within in-progress
		const result = await reorderTasksInColumn(testProject, "B", 0);

		expect(result.map((t) => t.id)).toEqual(["B", "C", "A"]);
		expect(result.every((t) => t.columnOrder !== undefined)).toBe(true);
	});

	it("multiple cross-column moves with dropPosition=top: latest at top", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "in-progress", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "D", seq: 4, status: "todo", createdAt: "2025-01-04T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move C into in-progress (top) → [C, A, B]
		await updateTask(testProject, "C", { status: "in-progress" }, { dropPosition: "top" });
		// Move D into in-progress (top) → [D, C, A, B]
		await updateTask(testProject, "D", { status: "in-progress" }, { dropPosition: "top" });

		const loaded = await loadTasks(testProject);
		const ipTasks = loaded
			.filter((t) => t.status === "in-progress")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));
		expect(ipTasks.map((t) => t.id)).toEqual(["D", "C", "A", "B"]);
	});

	it("multiple cross-column moves with dropPosition=bottom: latest at bottom", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "in-progress", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "D", seq: 4, status: "todo", createdAt: "2025-01-04T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move C into in-progress (bottom) → [A, B, C]
		await updateTask(testProject, "C", { status: "in-progress" }, { dropPosition: "bottom" });
		// Move D into in-progress (bottom) → [A, B, C, D]
		await updateTask(testProject, "D", { status: "in-progress" }, { dropPosition: "bottom" });

		const loaded = await loadTasks(testProject);
		const ipTasks = loaded
			.filter((t) => t.status === "in-progress")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));
		expect(ipTasks.map((t) => t.id)).toEqual(["A", "B", "C", "D"]);
	});
});

// ============================================================
// Frontend sort vs backend sort mismatch
// ============================================================

describe("backend sort order vs frontend sort order mismatch", () => {
	it("backend uses columnOrder+createdAt, NOT movedAt — potential mismatch with frontend", async () => {
		// Scenario: A and B have columnOrder, C was just moved in (has movedAt but no columnOrder)
		// Frontend sort (sortTasksForColumn) with empty moveOrderMap and "top" mode:
		//   - A(columnOrder 0) → first, B(columnOrder 1) → second
		//   - C(movedAt set, no columnOrder) → AFTER those with columnOrder
		//
		// Backend sort in reorderTasksInColumn:
		//   - A(columnOrder 0) → first, B(columnOrder 1) → second
		//   - C(no columnOrder, createdAt) → last
		//
		// So they MATCH in this case. But what if C was created BEFORE A?

		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-06-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-07-01T00:00:00Z", columnOrder: 1 }),
			// C was created much earlier, then moved to this column recently
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-01T00:00:00Z", movedAt: "2026-03-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Backend initial sort: A(col 0), B(col 1), C(no col, createdAt Jan → last because no col)
		// Even though C has movedAt, backend doesn't consider it
		// So backend order is [A, B, C]

		// If frontend shows (in "top" mode, no moveOrderMap):
		// Tasks with columnOrder first: A(0), B(1)
		// Then C with movedAt → goes before tasks without movedAt (but there are none without)
		// So frontend order matches: [A, B, C]

		// But what if there's a 4th task without movedAt or columnOrder?
		const tasks2 = [
			...tasks,
			makeTask({ id: "D", seq: 4, status: "todo", createdAt: "2025-03-01T00:00:00Z" }),
		];
		seedTasks(tasks2);

		// Frontend sort ("top" mode, no moveOrderMap):
		//   - A(col 0), B(col 1) → first by columnOrder
		//   - C has movedAt → before D (which has no movedAt) → C before D
		//   - Frontend: [A, B, C, D]
		//
		// Backend sort in reorderTasksInColumn:
		//   - A(col 0), B(col 1) → first
		//   - C(no col, createdAt Jan), D(no col, createdAt Mar) → by createdAt
		//   - Backend: [A, B, C, D]  ← C is before D because C.createdAt < D.createdAt

		// In this specific case they happen to match. But swap created dates:
		const tasks3 = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-06-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-07-01T00:00:00Z", columnOrder: 1 }),
			// C: created AFTER D, but movedAt is set
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-05-01T00:00:00Z", movedAt: "2026-03-01T00:00:00Z" }),
			// D: created BEFORE C, no movedAt
			makeTask({ id: "D", seq: 4, status: "todo", createdAt: "2025-02-01T00:00:00Z" }),
		];
		seedTasks(tasks3);

		// Backend sort: A(col 0), B(col 1), D(no col, created Feb), C(no col, created May)
		// Frontend sort ("top" mode): A(col 0), B(col 1), C(has movedAt → before D), D(no movedAt)
		//
		// MISMATCH: Backend says [A, B, D, C], Frontend says [A, B, C, D]

		// Let's verify backend order:
		// Reorder D to position 0 — this reveals the backend's initial sort
		const result = await reorderTasksInColumn(testProject, "D", 0);

		// Backend initial order was [A, B, D, C] (D before C because D.createdAt < C.createdAt)
		// Moving D from index 2 to index 0 in [A, B, C] remaining → [D, A, B, C]
		expect(result.map((t) => t.id)).toEqual(["D", "A", "B", "C"]);

		// This documents the mismatch: if frontend user sees [A, B, C, D] and
		// tries to reorder based on visual positions, the targetIndex will be wrong
		// because backend has [A, B, D, C] as its starting order.
	});
});

// ============================================================
// columnOrder cleared on status change, interaction with existing order
// ============================================================

describe("updateTask — columnOrder lifecycle", () => {
	it("moving task to new column with dropPosition=top assigns columnOrder 0", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "in-progress", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move C to in-progress with dropPosition=top
		const updated = await updateTask(testProject, "C", { status: "in-progress" }, { dropPosition: "top" });

		// C should be at position 0, A and B should be renumbered
		expect(updated.columnOrder).toBe(0);
		expect(updated.movedAt).toBeDefined();

		const loaded = await loadTasks(testProject);
		const ipTasks = loaded
			.filter((t) => t.status === "in-progress")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));
		expect(ipTasks.map((t) => t.id)).toEqual(["C", "A", "B"]);
		expect(ipTasks[0].columnOrder).toBe(0);
		expect(ipTasks[1].columnOrder).toBe(1);
		expect(ipTasks[2].columnOrder).toBe(2);
	});

	it("moving task to new column with dropPosition=bottom assigns last columnOrder", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "in-progress", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "in-progress", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move C to in-progress with dropPosition=bottom
		const updated = await updateTask(testProject, "C", { status: "in-progress" }, { dropPosition: "bottom" });

		// C should be at last position
		expect(updated.columnOrder).toBe(2);
		expect(updated.movedAt).toBeDefined();

		const loaded = await loadTasks(testProject);
		const ipTasks = loaded
			.filter((t) => t.status === "in-progress")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));
		expect(ipTasks.map((t) => t.id)).toEqual(["A", "B", "C"]);
	});

	it("moving task out and back with dropPosition=top puts it at top", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z", columnOrder: 2 }),
		];
		seedTasks(tasks);

		// Move B to in-progress
		await updateTask(testProject, "B", { status: "in-progress" }, { dropPosition: "top" });

		// Move B back to todo with dropPosition=top
		const updated = await updateTask(testProject, "B", { status: "todo" }, { dropPosition: "top" });

		// B should be at position 0 in todo
		expect(updated.columnOrder).toBe(0);
		expect(updated.movedAt).toBeDefined();

		const loaded = await loadTasks(testProject);
		const todoTasks = loaded
			.filter((t) => t.status === "todo")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));
		expect(todoTasks.map((t) => t.id)).toEqual(["B", "A", "C"]);
	});

	it("without dropPosition, columnOrder is cleared (backward compat)", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
		];
		seedTasks(tasks);

		const updated = await updateTask(testProject, "A", { status: "in-progress" });

		expect(updated.columnOrder).toBeUndefined();
		expect(updated.movedAt).toBeDefined();
	});

	it("updating non-status fields preserves columnOrder", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", columnOrder: 5, createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		await updateTask(testProject, "A", { title: "New title" });

		const loaded = await loadTasks(testProject);
		expect(loaded[0].columnOrder).toBe(5);
	});

	it("updating to same status does NOT clear columnOrder", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", columnOrder: 3, createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		await updateTask(testProject, "A", { status: "todo" });

		const loaded = await loadTasks(testProject);
		expect(loaded[0].columnOrder).toBe(3);
	});
});

// ============================================================
// JSON serialization of columnOrder: undefined
// ============================================================

describe("columnOrder serialization — undefined handling", () => {
	it("columnOrder: undefined is omitted from JSON when no dropPosition given", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", columnOrder: 5, createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		// Move to different status without dropPosition → clears columnOrder
		await updateTask(testProject, "A", { status: "in-progress" });

		const raw = mockFileStore[tasksFilePath()];
		const parsed = JSON.parse(raw);

		// The key should not be present (JSON.stringify omits undefined)
		expect("columnOrder" in parsed[0]).toBe(false);
	});

	it("columnOrder is a number in JSON when dropPosition is given", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", columnOrder: 5, createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		await updateTask(testProject, "A", { status: "in-progress" }, { dropPosition: "top" });

		const raw = mockFileStore[tasksFilePath()];
		const parsed = JSON.parse(raw);

		expect(parsed[0].columnOrder).toBe(0);
	});

	it("loading task without columnOrder key gives undefined (not null)", async () => {
		// Simulate raw JSON without columnOrder field
		const raw = [{
			id: "A",
			seq: 1,
			projectId: "proj-1",
			title: "Test",
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
			labelIds: [],
		}];
		mockFileStore[tasksFilePath()] = JSON.stringify(raw);

		const loaded = await loadTasks(testProject);
		expect(loaded[0].columnOrder).toBeUndefined();
	});
});

// ============================================================
// Full lifecycle: create → reorder → move out → move back → reorder
// ============================================================

describe("full lifecycle — order persistence through status transitions", () => {
	it("order is maintained through create → reorder → reload", async () => {
		// Create 3 tasks
		const t1 = await addTask(testProject, "Task 1");
		const t2 = await addTask(testProject, "Task 2");
		const t3 = await addTask(testProject, "Task 3");

		// Reorder: T3 to front
		await reorderTasksInColumn(testProject, t3.id, 0);

		// Simulate reload: load from disk, sort by columnOrder
		const loaded = await loadTasks(testProject);
		const sorted = loaded
			.filter((t) => t.status === "todo")
			.sort((a, b) => {
				if (a.columnOrder !== undefined && b.columnOrder !== undefined) return a.columnOrder - b.columnOrder;
				if (a.columnOrder !== undefined) return -1;
				if (b.columnOrder !== undefined) return 1;
				return a.createdAt < b.createdAt ? -1 : 1;
			});

		expect(sorted.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id]);
	});

	it("move out + move back with dropPosition=top puts task at top", async () => {
		const task1 = await addTask(testProject, "Task 1");
		const task2 = await addTask(testProject, "Task 2");
		const task3 = await addTask(testProject, "Task 3");

		// Reorder: T3 to front → [T3, T1, T2]
		await reorderTasksInColumn(testProject, task3.id, 0);

		// Move T3 to in-progress
		await updateTask(testProject, task3.id, { status: "in-progress" }, { dropPosition: "top" });

		// Move T3 back to todo with dropPosition=top → should be at top
		await updateTask(testProject, task3.id, { status: "todo" }, { dropPosition: "top" });

		const loaded = await loadTasks(testProject);
		const todoTasks = loaded
			.filter((t) => t.status === "todo")
			.sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));

		// T3 should be back at top
		expect(todoTasks.map((t) => t.id)).toEqual([task3.id, task1.id, task2.id]);
		// All have columnOrder
		expect(todoTasks.every((t) => t.columnOrder !== undefined)).toBe(true);
	});

	it("columnOrder gap after task removal — reorder still works", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z", columnOrder: 0 }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z", columnOrder: 1 }),
			makeTask({ id: "C", seq: 3, status: "todo", createdAt: "2025-01-03T00:00:00Z", columnOrder: 2 }),
		];
		seedTasks(tasks);

		// Move B out (simulating it being moved to another column)
		await updateTask(testProject, "B", { status: "in-progress" });

		// Now todo has A(col 0) and C(col 2) — gap at 1
		// Reorder C to position 0
		const result = await reorderTasksInColumn(testProject, "C", 0);

		expect(result.map((t) => t.id)).toEqual(["C", "A"]);
		expect(result[0].columnOrder).toBe(0);
		expect(result[1].columnOrder).toBe(1);
		// Gap is normalized
	});
});

// ============================================================
// Edge cases
// ============================================================

describe("reorderTasksInColumn — edge cases", () => {
	it("throws on non-existent taskId", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		await expect(reorderTasksInColumn(testProject, "NONEXISTENT", 0)).rejects.toThrow("Task not found");
	});

	it("single task in column — reorder is a no-op", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "A", 0);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("A");
		expect(result[0].columnOrder).toBe(0);
	});

	it("two tasks — swap", async () => {
		const tasks = [
			makeTask({ id: "A", seq: 1, status: "todo", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", seq: 2, status: "todo", createdAt: "2025-01-02T00:00:00Z" }),
		];
		seedTasks(tasks);

		const result = await reorderTasksInColumn(testProject, "B", 0);

		expect(result.map((t) => t.id)).toEqual(["B", "A"]);
	});

	it("handles 10+ tasks correctly", async () => {
		const tasks = Array.from({ length: 10 }, (_, i) =>
			makeTask({
				id: `T${i}`,
				seq: i + 1,
				status: "todo",
				createdAt: new Date(2025, 0, i + 1).toISOString(),
			}),
		);
		seedTasks(tasks);

		// Move last to first
		const result = await reorderTasksInColumn(testProject, "T9", 0);

		expect(result[0].id).toBe("T9");
		expect(result[1].id).toBe("T0");
		expect(result.length).toBe(10);
		// All have sequential columnOrder
		for (let i = 0; i < result.length; i++) {
			expect(result[i].columnOrder).toBe(i);
		}
	});
});
