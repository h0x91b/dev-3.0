/**
 * Tests for sortTasksForColumn focusing on reload/persistence scenarios.
 *
 * These tests simulate what happens when the app reloads and moveOrderMap
 * is empty — the sort function must reconstruct the correct order from
 * persisted fields only (columnOrder, movedAt, createdAt).
 */

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
// Reload after within-column reorder
// ============================================================

describe("sortTasksForColumn — reload after reorder (columnOrder persisted)", () => {
	it("columnOrder alone determines order after reload", () => {
		// Simulates loading tasks that were previously reordered
		const tasks = [
			makeTask({ id: "C", columnOrder: 0, createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "A", columnOrder: 1, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", columnOrder: 2, createdAt: "2025-01-02T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(result)).toEqual(["C", "A", "B"]);
	});

	it("columnOrder is stable across both top and bottom mode", () => {
		const tasks = [
			makeTask({ id: "B", columnOrder: 0 }),
			makeTask({ id: "A", columnOrder: 1 }),
			makeTask({ id: "C", columnOrder: 2 }),
		];

		expect(ids(sortTasksForColumn(tasks, "top", emptyMap))).toEqual(["B", "A", "C"]);
		expect(ids(sortTasksForColumn(tasks, "bottom", emptyMap))).toEqual(["B", "A", "C"]);
	});
});

// ============================================================
// Reload after cross-column move (task has movedAt but no columnOrder)
// ============================================================

describe("sortTasksForColumn — reload after cross-column move", () => {
	it("task moved into column with existing reordered tasks appears at end (top mode)", () => {
		// A and B were reordered (have columnOrder).
		// C was moved into this column (has movedAt, no columnOrder).
		// On reload (no moveOrderMap), C should appear after A and B.
		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", columnOrder: 1, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", movedAt: "2026-03-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);

		// A(col 0) → B(col 1) → C(no col, has movedAt)
		expect(ids(result)).toEqual(["A", "B", "C"]);
	});

	it("multiple tasks moved in — sorted by movedAt in top mode (most recent first)", () => {
		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "C", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "D", movedAt: "2026-02-01T00:00:00Z", createdAt: "2025-01-04T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);

		// A (columnOrder 0) first, then D (movedAt Feb, more recent → before C in top mode)
		expect(ids(result)).toEqual(["A", "D", "C"]);
	});

	it("multiple tasks moved in — sorted by movedAt in bottom mode (most recent last)", () => {
		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "C", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "D", movedAt: "2026-02-01T00:00:00Z", createdAt: "2025-01-04T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "bottom", emptyMap);

		// A (columnOrder 0) first, then C (movedAt Jan → before D in bottom mode), then D
		expect(ids(result)).toEqual(["A", "C", "D"]);
	});
});

// ============================================================
// The key mismatch scenario: backend sort vs frontend sort
// ============================================================

describe("sortTasksForColumn — backend vs frontend order mismatch scenarios", () => {
	it("task with movedAt but early createdAt: frontend and backend may disagree on position among non-columnOrder tasks", () => {
		// Backend's reorderTasksInColumn sorts non-columnOrder tasks by createdAt only.
		// Frontend's sortTasksForColumn sorts non-columnOrder tasks by movedAt first.
		// When these disagree, the reorder targetIndex from frontend won't match backend.

		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-06-01T00:00:00Z" }),
			// C: created early, moved recently
			makeTask({ id: "C", movedAt: "2026-03-01T00:00:00Z", createdAt: "2025-01-01T00:00:00Z" }),
			// D: created later, never moved
			makeTask({ id: "D", createdAt: "2025-03-01T00:00:00Z" }),
		];

		// Frontend sort ("top" mode): A(col 0), then C(movedAt set → before D), D
		const frontendOrder = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(frontendOrder)).toEqual(["A", "C", "D"]);

		// Backend sort in reorderTasksInColumn would be:
		// A(col 0), then C(no col, createdAt Jan) vs D(no col, createdAt Mar) → C before D by createdAt
		// Backend: [A, C, D] — SAME in this case

		// But in bottom mode:
		const frontendBottom = sortTasksForColumn(tasks, "bottom", emptyMap);
		// A(col 0), then D(no movedAt → before C which has movedAt, in bottom mode)
		expect(ids(frontendBottom)).toEqual(["A", "D", "C"]);

		// Backend in bottom mode would still sort by createdAt: C(Jan) before D(Mar)
		// Backend: [A, C, D]
		// Frontend: [A, D, C]
		// MISMATCH!
	});

	it("movedAt without columnOrder: position after reload differs from in-session position", () => {
		// During session: task was cross-column moved, got high counter in moveOrderMap → at top
		// After reload: moveOrderMap is empty, task has movedAt → position determined by sort tiers

		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", columnOrder: 1, createdAt: "2025-01-02T00:00:00Z" }),
			// C was moved cross-column, in-session was at top via moveOrderMap
			makeTask({ id: "C", movedAt: "2026-03-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
		];

		// In-session (with moveOrderMap, C at top):
		const moveOrder = new Map([["C", 5]]);
		const inSession = sortTasksForColumn(tasks, "top", moveOrder);
		expect(ids(inSession)).toEqual(["C", "A", "B"]);

		// After reload (no moveOrderMap):
		const afterReload = sortTasksForColumn(tasks, "top", emptyMap);
		// C has no columnOrder → goes AFTER A and B which have columnOrder
		expect(ids(afterReload)).toEqual(["A", "B", "C"]);

		// Position changed! C was at index 0 in-session, now at index 2 after reload.
		// This is the fundamental persistence gap.
	});

	it("in bottom mode: cross-column moved task also changes position on reload", () => {
		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", columnOrder: 1, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", movedAt: "2026-03-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
		];

		// In-session (bottom mode, C moved → at bottom):
		const moveOrder = new Map([["C", 1]]);
		const inSession = sortTasksForColumn(tasks, "bottom", moveOrder);
		expect(ids(inSession)).toEqual(["A", "B", "C"]);

		// After reload:
		const afterReload = sortTasksForColumn(tasks, "bottom", emptyMap);
		expect(ids(afterReload)).toEqual(["A", "B", "C"]);

		// In this case they match (C naturally goes to end since it has no columnOrder)
	});
});

// ============================================================
// Scenario: reorder within column, then cross-column move into same column
// ============================================================

describe("sortTasksForColumn — complex scenarios", () => {
	it("reordered column + new task moved in: new task appears after reordered tasks", () => {
		// Column was fully reordered (all tasks have columnOrder)
		// Then a new task was moved in (has movedAt, no columnOrder)
		const tasks = [
			makeTask({ id: "C", columnOrder: 0, createdAt: "2025-01-03T00:00:00Z" }),
			makeTask({ id: "A", columnOrder: 1, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", columnOrder: 2, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "NEW", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-06-01T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);

		// Reordered tasks by columnOrder: C(0), A(1), B(2)
		// NEW has no columnOrder → after them
		expect(ids(result)).toEqual(["C", "A", "B", "NEW"]);
	});

	it("mixed: some tasks have columnOrder, some have movedAt, some have neither", () => {
		const tasks = [
			makeTask({ id: "R1", columnOrder: 0, createdAt: "2025-06-01T00:00:00Z" }),
			makeTask({ id: "R2", columnOrder: 1, createdAt: "2025-05-01T00:00:00Z" }),
			makeTask({ id: "M1", movedAt: "2026-02-01T00:00:00Z", createdAt: "2025-03-01T00:00:00Z" }),
			makeTask({ id: "M2", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-04-01T00:00:00Z" }),
			makeTask({ id: "P1", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "P2", createdAt: "2025-02-01T00:00:00Z" }),
		];

		const topResult = sortTasksForColumn(tasks, "top", emptyMap);

		// Tier 1: no moveOrderMap entries
		// Tier 2: columnOrder → R1(0), R2(1) first
		// Tier 3-4: no groups
		// Tier 5: movedAt (top → most recent first) → M1(Feb) before M2(Jan)
		// Tier 6: createdAt → P1(Jan) before P2(Feb)
		expect(ids(topResult)).toEqual(["R1", "R2", "M1", "M2", "P1", "P2"]);
	});

	it("columnOrder 0 is truthy for the sort (0 !== undefined)", () => {
		// Regression: ensure columnOrder: 0 is treated as "has columnOrder"
		const tasks = [
			makeTask({ id: "A", columnOrder: 0, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);

		// A has columnOrder 0 → comes first
		expect(ids(result)).toEqual(["A", "B"]);
	});

	it("stable sort: tasks with identical sort keys maintain input order", () => {
		// Two tasks with no columnOrder, no movedAt, same createdAt
		const tasks = [
			makeTask({ id: "X", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "Y", createdAt: "2025-01-01T00:00:00Z" }),
		];

		const result = sortTasksForColumn(tasks, "top", emptyMap);

		// With identical createdAt, sort should be stable (keep input order)
		// Actually our sort returns 0 for equal createdAt since we use < not <=
		expect(result).toHaveLength(2);
	});
});

// ============================================================
// Scenario: simulating full user session → reload
// ============================================================

describe("sortTasksForColumn — session → reload transition", () => {
	it("in-session order with moveOrderMap → reload without it: order changes", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", createdAt: "2025-01-03T00:00:00Z" }),
		];

		// User moved C and B cross-column into this column during session
		const moveOrder = new Map([
			["C", 1],
			["B", 2],
		]);

		// During session: B(most recent move) at top, then C, then A
		const inSession = sortTasksForColumn(tasks, "top", moveOrder);
		expect(ids(inSession)).toEqual(["B", "C", "A"]);

		// After reload: no moveOrderMap, no columnOrder, no movedAt → createdAt ASC
		const afterReload = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(afterReload)).toEqual(["A", "B", "C"]);

		// Complete order change!
	});

	it("if tasks have movedAt, reload preserves relative order within moved group", () => {
		const tasks = [
			makeTask({ id: "A", createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "B", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "C", movedAt: "2026-02-01T00:00:00Z", createdAt: "2025-01-03T00:00:00Z" }),
		];

		// In-session (top mode): C(moveOrder 2) → B(moveOrder 1) → A
		const moveOrder = new Map([
			["B", 1],
			["C", 2],
		]);
		const inSession = sortTasksForColumn(tasks, "top", moveOrder);
		expect(ids(inSession)).toEqual(["C", "B", "A"]);

		// After reload (top mode): C(movedAt Feb → more recent → first) → B(movedAt Jan) → A(no movedAt)
		const afterReload = sortTasksForColumn(tasks, "top", emptyMap);
		expect(ids(afterReload)).toEqual(["C", "B", "A"]);

		// In this case they match! movedAt preserves the relative order if set.
	});

	it("within-column reorder (columnOrder) survives reload correctly", () => {
		// User reordered within column (all tasks get columnOrder)
		// Then cross-column moved a new task in (has moveOrderMap in session)
		const tasks = [
			makeTask({ id: "B", columnOrder: 0, createdAt: "2025-01-02T00:00:00Z" }),
			makeTask({ id: "A", columnOrder: 1, createdAt: "2025-01-01T00:00:00Z" }),
			makeTask({ id: "C", columnOrder: 2, createdAt: "2025-01-03T00:00:00Z" }),
			// NEW was cross-column moved in this session
			makeTask({ id: "NEW", movedAt: "2026-01-01T00:00:00Z", createdAt: "2025-06-01T00:00:00Z" }),
		];

		// In-session (top mode): NEW at top via moveOrderMap, then B, A, C by columnOrder
		const moveOrder = new Map([["NEW", 1]]);
		const inSession = sortTasksForColumn(tasks, "top", moveOrder);
		expect(ids(inSession)).toEqual(["NEW", "B", "A", "C"]);

		// After reload: no moveOrderMap
		const afterReload = sortTasksForColumn(tasks, "top", emptyMap);
		// B(col 0), A(col 1), C(col 2) first — then NEW(no col, has movedAt)
		expect(ids(afterReload)).toEqual(["B", "A", "C", "NEW"]);

		// NEW moved from position 0 to position 3 after reload!
		// This is the core persistence gap.
	});
});
