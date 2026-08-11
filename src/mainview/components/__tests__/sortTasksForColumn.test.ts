import { describe, it, expect } from "vitest";
import { compareTasksInBand, sortTasksForColumn, taskActivityTime } from "../sortTasks";
import type { Task } from "../../../shared/types";

let nextSeq = 1;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		seq: nextSeq++,
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

/** ISO stamp N days into 2025-02, so ordering is obvious from the day number. */
function day(n: number): string {
	return `2025-02-${String(n).padStart(2, "0")}T00:00:00Z`;
}

describe("taskActivityTime — which clock a task is sorted by", () => {
	it("prefers statusEnteredAt over movedAt and createdAt", () => {
		const task = makeTask({ id: "a", createdAt: day(1), movedAt: day(2), statusEnteredAt: day(3) });
		expect(taskActivityTime(task)).toBe(Date.parse(day(3)));
	});

	it("falls back to movedAt when statusEnteredAt is absent (task predates status-time tracking)", () => {
		const task = makeTask({ id: "a", createdAt: day(1), movedAt: day(2) });
		expect(taskActivityTime(task)).toBe(Date.parse(day(2)));
	});

	it("falls back to createdAt when neither stamp exists", () => {
		const task = makeTask({ id: "a", createdAt: day(1) });
		expect(taskActivityTime(task)).toBe(Date.parse(day(1)));
	});

	it("treats an unparseable stamp as the epoch instead of producing NaN", () => {
		const task = makeTask({ id: "a", statusEnteredAt: "not-a-date" });
		expect(taskActivityTime(task)).toBe(0);
	});
});

describe("sortTasksForColumn — oldest-first (default)", () => {
	it("floats the task whose status changed longest ago to the top", () => {
		const tasks = [
			makeTask({ id: "fresh", statusEnteredAt: day(9) }),
			makeTask({ id: "stale", statusEnteredAt: day(1) }),
			makeTask({ id: "middle", statusEnteredAt: day(5) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["stale", "middle", "fresh"]);
	});

	it("keeps priority as the topmost key — every P0 above every P1", () => {
		const tasks = [
			makeTask({ id: "p1-stale", priority: "P1", statusEnteredAt: day(1) }),
			makeTask({ id: "p0-fresh", priority: "P0", statusEnteredAt: day(9) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["p0-fresh", "p1-stale"]);
	});

	it("sinks hibernated tasks below every live P4, however stale they are", () => {
		const tasks = [
			makeTask({ id: "parked", priority: "P0", hibernated: true, statusEnteredAt: day(1) }),
			makeTask({ id: "live", priority: "P4", statusEnteredAt: day(9) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["live", "parked"]);
	});

	it("breaks an exact tie on seq, so the order is stable across reloads", () => {
		const tasks = [
			makeTask({ id: "b", seq: 20, statusEnteredAt: day(3) }),
			makeTask({ id: "a", seq: 10, statusEnteredAt: day(3) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["a", "b"]);
	});

	it("does not hold a variant group together — every task stands on its own", () => {
		const tasks = [
			makeTask({ id: "v1", groupId: "g", variantIndex: 0, statusEnteredAt: day(9) }),
			makeTask({ id: "loner", statusEnteredAt: day(5) }),
			makeTask({ id: "v2", groupId: "g", variantIndex: 1, statusEnteredAt: day(1) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["v2", "loner", "v1"]);
	});

	it("ignores a legacy columnOrder left over on disk", () => {
		const tasks = [
			makeTask({ id: "pinned", columnOrder: 0, statusEnteredAt: day(9) }),
			makeTask({ id: "stale", columnOrder: 5, statusEnteredAt: day(1) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first"))).toEqual(["stale", "pinned"]);
	});
});

describe("sortTasksForColumn — newest-first", () => {
	it("puts the most recently active task on top", () => {
		const tasks = [
			makeTask({ id: "stale", statusEnteredAt: day(1) }),
			makeTask({ id: "fresh", statusEnteredAt: day(9) }),
			makeTask({ id: "middle", statusEnteredAt: day(5) }),
		];
		expect(ids(sortTasksForColumn(tasks, "newest-first"))).toEqual(["fresh", "middle", "stale"]);
	});

	it("still sorts priority bands first", () => {
		const tasks = [
			makeTask({ id: "p2-fresh", priority: "P2", statusEnteredAt: day(9) }),
			makeTask({ id: "p0-stale", priority: "P0", statusEnteredAt: day(1) }),
		];
		expect(ids(sortTasksForColumn(tasks, "newest-first"))).toEqual(["p0-stale", "p2-fresh"]);
	});
});

describe("sortTasksForColumn — completed / cancelled columns", () => {
	it("shows the freshest finish on top regardless of the sort setting", () => {
		const tasks = [
			makeTask({ id: "old", status: "completed", movedAt: day(1) }),
			makeTask({ id: "recent", status: "completed", movedAt: day(9) }),
		];
		for (const order of ["oldest-first", "newest-first"] as const) {
			expect(ids(sortTasksForColumn(tasks, order, "completed"))).toEqual(["recent", "old"]);
		}
	});

	it("ignores priority there — the terminal column is a log, not a queue", () => {
		const tasks = [
			makeTask({ id: "p4-recent", status: "cancelled", priority: "P4", movedAt: day(9) }),
			makeTask({ id: "p0-old", status: "cancelled", priority: "P0", movedAt: day(1) }),
		];
		expect(ids(sortTasksForColumn(tasks, "oldest-first", "cancelled"))).toEqual(["p4-recent", "p0-old"]);
	});
});

describe("compareTasksInBand", () => {
	it("returns 0 only for a task compared with itself", () => {
		const task = makeTask({ id: "a", statusEnteredAt: day(3) });
		expect(compareTasksInBand(task, task, "oldest-first")).toBe(0);
	});

	it("is symmetric — swapping the arguments flips the sign", () => {
		const a = makeTask({ id: "a", statusEnteredAt: day(1) });
		const b = makeTask({ id: "b", statusEnteredAt: day(2) });
		expect(Math.sign(compareTasksInBand(a, b, "oldest-first"))).toBe(-Math.sign(compareTasksInBand(b, a, "oldest-first")));
	});

	it("does not mutate the input array when used through sortTasksForColumn", () => {
		const tasks = [makeTask({ id: "b", statusEnteredAt: day(9) }), makeTask({ id: "a", statusEnteredAt: day(1) })];
		sortTasksForColumn(tasks, "oldest-first");
		expect(ids(tasks)).toEqual(["b", "a"]);
	});
});
