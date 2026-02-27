import { describe, it, expect } from "vitest";
import { sortTasksForColumn } from "../sortTasks";
import type { Task } from "../../../shared/types";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		seq: 1,
		projectId: "p1",
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

function ids(tasks: Task[]): string[] {
	return tasks.map((t) => t.id);
}

const emptyMap = new Map<string, number>();

// ============================================================
// "top" mode — moveOrderMap (in-session moves)
// ============================================================

describe('sortTasksForColumn — "top" mode with moveOrderMap', () => {
	it("single moved task goes to top", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];
		const moveOrder = new Map([["B", 1]]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		expect(ids(result)).toEqual(["B", "A", "C"]);
	});

	it("multiple moves: most recently moved first", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];
		// Moved in order: A(1), then C(2), then B(3)
		const moveOrder = new Map([
			["A", 1],
			["C", 2],
			["B", 3],
		]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		// B moved last → top, then C, then A
		expect(ids(result)).toEqual(["B", "C", "A"]);
	});

	it("unmoved tasks stay in original createdAt ASC order below moved", () => {
		const tasks = [
			makeTask({ id: "X", createdAt: "2025-06-01T00:00:00Z" }),
			makeTask({ id: "Y", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "Z", createdAt: "2025-03-01T00:00:00Z" }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		// No moves → createdAt ASC: Y(Jan), Z(Mar), X(Jun)
		expect(ids(result)).toEqual(["Y", "Z", "X"]);
	});

	it("moved tasks above unmoved tasks", () => {
		const tasks = [
			makeTask({ id: "OLD", createdAt: "2020-01-01T00:00:00Z" }),
			makeTask({ id: "NEW", createdAt: "2026-01-01T00:00:00Z" }),
		];
		const moveOrder = new Map([["OLD", 1]]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		// OLD was moved → goes to top even though it's older
		expect(ids(result)).toEqual(["OLD", "NEW"]);
	});
});

// ============================================================
// "top" mode — variant tasks (grouped)
// ============================================================

describe('sortTasksForColumn — "top" mode with grouped/variant tasks', () => {
	it("moveOrderMap overrides variantIndex for grouped tasks", () => {
		const tasks = [
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "V5", groupId: "g1", variantIndex: 5, createdAt: "2025-01-01T00:00:00Z" }),
		];
		// User moved V5 first, then V2, then V3 (V3 = most recent)
		const moveOrder = new Map([
			["V5", 1],
			["V2", 2],
			["V3", 3],
		]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		// V3 moved last → top, then V2, then V5
		expect(ids(result)).toEqual(["V3", "V2", "V5"]);
	});

	it("grouped tasks without moveOrderMap: fall back to variantIndex ASC", () => {
		const tasks = [
			makeTask({ id: "V5", groupId: "g1", variantIndex: 5 }),
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(result)).toEqual(["V2", "V3", "V5"]);
	});

	it("partially moved variants: moved ones on top, rest by variantIndex", () => {
		const tasks = [
			makeTask({ id: "V1", groupId: "g1", variantIndex: 1 }),
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
		];
		const moveOrder = new Map([["V3", 1]]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		// V3 moved → top, then V1 and V2 by variantIndex
		expect(ids(result)).toEqual(["V3", "V1", "V2"]);
	});
});

// ============================================================
// "top" mode — movedAt fallback (persisted, no moveOrderMap)
// ============================================================

describe('sortTasksForColumn — "top" mode with movedAt fallback', () => {
	it("tasks with movedAt above tasks without", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-06-01T00:00:00Z", movedAt: "2026-01-01T00:00:00Z" }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(result)).toEqual(["B", "A"]);
	});

	it("multiple movedAt: most recently moved first", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z", movedAt: "2026-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z", movedAt: "2026-02-01T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		// B movedAt is more recent → first, then A, then C (no movedAt)
		expect(ids(result)).toEqual(["B", "A", "C"]);
	});
});

// ============================================================
// "bottom" mode — moveOrderMap (in-session moves)
// ============================================================

describe('sortTasksForColumn — "bottom" mode with moveOrderMap', () => {
	it("single moved task goes to bottom", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];
		const moveOrder = new Map([["B", 1]]);
		const result = sortTasksForColumn(tasks, "bottom", moveOrder);
		// B moved → goes to bottom; A, C stay in createdAt ASC above
		expect(ids(result)).toEqual(["A", "C", "B"]);
	});

	it("multiple moves: most recently moved last (bottom)", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];
		// Moved in order: A(1), then C(2), then B(3) → B is most recently moved
		const moveOrder = new Map([
			["A", 1],
			["C", 2],
			["B", 3],
		]);
		const result = sortTasksForColumn(tasks, "bottom", moveOrder);
		// Moved tasks go to bottom, most recent = last: A(1), C(2), B(3)
		expect(ids(result)).toEqual(["A", "C", "B"]);
	});

	it("unmoved tasks stay in original createdAt ASC order above moved", () => {
		const tasks = [
			makeTask({ id: "X", createdAt: "2025-06-01T00:00:00Z" }),
			makeTask({ id: "Y", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "MOVED", createdAt: "2025-03-01T00:00:00Z" }),
		];
		const moveOrder = new Map([["MOVED", 1]]);
		const result = sortTasksForColumn(tasks, "bottom", moveOrder);
		// Unmoved in createdAt ASC: Y(Jan), X(Jun); then MOVED at bottom
		expect(ids(result)).toEqual(["Y", "X", "MOVED"]);
	});
});

// ============================================================
// "bottom" mode — variant tasks (grouped)
// ============================================================

describe('sortTasksForColumn — "bottom" mode with grouped/variant tasks', () => {
	it("moveOrderMap overrides variantIndex for grouped tasks", () => {
		const tasks = [
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
			makeTask({ id: "V5", groupId: "g1", variantIndex: 5 }),
		];
		// User moved V3 first, then V2, then V5 (V5 most recent → should be last)
		const moveOrder = new Map([
			["V3", 1],
			["V2", 2],
			["V5", 3],
		]);
		const result = sortTasksForColumn(tasks, "bottom", moveOrder);
		expect(ids(result)).toEqual(["V3", "V2", "V5"]);
	});

	it("grouped tasks without moveOrderMap: fall back to variantIndex ASC", () => {
		const tasks = [
			makeTask({ id: "V5", groupId: "g1", variantIndex: 5 }),
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
		];
		const result = sortTasksForColumn(tasks, "bottom", emptyMap);
		expect(ids(result)).toEqual(["V2", "V3", "V5"]);
	});
});

// ============================================================
// "bottom" mode — no moveOrderMap (default behavior)
// ============================================================

describe('sortTasksForColumn — "bottom" mode without moveOrderMap', () => {
	it("sorts by createdAt ASC (oldest first)", () => {
		const tasks = [
			makeTask({ id: "C", createdAt: "2025-03-01T00:00:00Z" }),
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-02-01T00:00:00Z" }),
		];
		const result = sortTasksForColumn(tasks, "bottom", emptyMap);
		expect(ids(result)).toEqual(["A", "B", "C"]);
	});
});

// ============================================================
// Group structure tests (both modes)
// ============================================================

describe("sortTasksForColumn — group structure", () => {
	it("grouped tasks appear before ungrouped", () => {
		const tasks = [
			makeTask({ id: "U1", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "G1", groupId: "g1", variantIndex: 1, createdAt: "2025-06-01T00:00:00Z" }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(result)).toEqual(["G1", "U1"]);
	});

	it("different groups: sorted by groupId", () => {
		const tasks = [
			makeTask({ id: "B1", groupId: "group-b", variantIndex: 1 }),
			makeTask({ id: "A1", groupId: "group-a", variantIndex: 1 }),
		];
		const result = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(result)).toEqual(["A1", "B1"]);
	});
});

// ============================================================
// User scenario: drag 3, 2, 5 — expect 5 on top (top mode)
// ============================================================

describe("sortTasksForColumn — user scenario: drag 3, 2, 5 in top mode", () => {
	it("tasks dragged in order #3, #2, #5 → result is #5, #2, #3", () => {
		const tasks = [
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
			makeTask({ id: "V5", groupId: "g1", variantIndex: 5 }),
		];
		// User dragged #3 first, then #2, then #5
		const moveOrder = new Map([
			["V3", 1],
			["V2", 2],
			["V5", 3],
		]);
		const result = sortTasksForColumn(tasks, "top", moveOrder);
		// #5 was moved last → should be at the very top
		expect(ids(result)).toEqual(["V5", "V2", "V3"]);
	});
});

// ============================================================
// User scenario: drag 4 tasks in bottom mode — expect at bottom
// ============================================================

describe("sortTasksForColumn — user scenario: insert at bottom", () => {
	it("task #4 dragged to column with #1, #2, #3 → #4 at bottom", () => {
		const tasks = [
			makeTask({ id: "V1", groupId: "g1", variantIndex: 1 }),
			makeTask({ id: "V2", groupId: "g1", variantIndex: 2 }),
			makeTask({ id: "V3", groupId: "g1", variantIndex: 3 }),
			makeTask({ id: "V4", groupId: "g1", variantIndex: 4 }),
		];
		// Only V4 was moved (the rest were already there)
		const moveOrder = new Map([["V4", 1]]);
		const result = sortTasksForColumn(tasks, "bottom", moveOrder);
		// V4 moved → should be at bottom; rest in variantIndex order
		expect(ids(result)).toEqual(["V1", "V2", "V3", "V4"]);
	});
});
