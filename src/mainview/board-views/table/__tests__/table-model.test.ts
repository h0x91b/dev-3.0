import { describe, expect, it } from "vitest";
import type { BoardColumnSlot, CustomColumn, Task } from "../../../../shared/types";
import {
	DEFAULT_TABLE_COLUMNS,
	defaultTableLayout,
	laneOfTask,
	normalizeTableLayout,
	sortTableTasks,
	toggleTableColumn,
	toggleTableSort,
	type TableSortContext,
} from "../table-model";

function task(overrides: Partial<Task>): Task {
	return {
		id: "t", seq: 1, projectId: "p1", title: "Task", description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
		...overrides,
	} as Task;
}

const reviewCol = { id: "c-review", name: "QA", color: "#fff" } as CustomColumn;
const columns: BoardColumnSlot[] = [
	{ type: "builtin", status: "todo" },
	{ type: "builtin", status: "in-progress" },
	{ type: "custom", col: reviewCol, members: [{ projectId: "p1", columnId: "c-review" }] },
	{ type: "builtin", status: "completed" },
];

const ctx: TableSortContext = {
	columns,
	agentName: (id) => ({ a1: "Claude", a2: "Codex" })[id ?? ""] ?? "",
	projectName: (id) => ({ p1: "Alpha", p2: "Beta" })[id] ?? "",
	taskSeqById: (id) => ({ parent1: 5, parent2: 2 })[id] ?? null,
	labelNames: (task) => (task.labelIds ?? []).map((id) => ({ x: "Bug", y: "Alpha" })[id] ?? ""),
};

describe("defaultTableLayout", () => {
	it("shows the D18 default columns sorted by activity, newest first", () => {
		expect(defaultTableLayout("project")).toEqual({ columns: [...DEFAULT_TABLE_COLUMNS], sort: ["activity", "desc"] });
	});

	it("adds the project column right after the title on a space board", () => {
		expect(defaultTableLayout("space").columns.slice(0, 3)).toEqual(["seq", "title", "project"]);
	});
});

describe("normalizeTableLayout", () => {
	it("falls back to the default for garbage", () => {
		expect(normalizeTableLayout(42, "project")).toEqual(defaultTableLayout("project"));
		expect(normalizeTableLayout({ columns: "x" }, "project")).toEqual(defaultTableLayout("project"));
	});

	it("drops unknown and duplicate columns and restores the canonical order", () => {
		const layout = normalizeTableLayout({ columns: ["priority", "bogus", "title", "priority"], sort: ["seq", "asc"] }, "project");
		expect(layout.columns).toEqual(["title", "priority"]);
		expect(layout.sort).toEqual(["seq", "asc"]);
	});

	it("always keeps the title column", () => {
		expect(normalizeTableLayout({ columns: ["seq"] }, "project").columns).toEqual(["seq", "title"]);
	});

	it("drops the project column on a project board", () => {
		expect(normalizeTableLayout({ columns: ["title", "project"] }, "project").columns).toEqual(["title"]);
	});

	it("replaces an invalid sort with the default sort", () => {
		expect(normalizeTableLayout({ columns: ["title"], sort: ["labels", "sideways"] }, "project").sort).toEqual(["activity", "desc"]);
	});
});

describe("toggleTableSort", () => {
	it("starts a new column descending for activity and created, ascending otherwise", () => {
		const base = defaultTableLayout("project");
		expect(toggleTableSort(base, "title").sort).toEqual(["title", "asc"]);
		expect(toggleTableSort({ ...base, sort: ["title", "asc"] }, "created").sort).toEqual(["created", "desc"]);
	});

	it("flips the direction on the active column", () => {
		const base = { ...defaultTableLayout("project"), sort: ["title", "asc"] as const };
		expect(toggleTableSort(base, "title").sort).toEqual(["title", "desc"]);
	});
});

describe("toggleTableColumn", () => {
	it("adds a hidden column in canonical order and removes a shown one", () => {
		const base = defaultTableLayout("project");
		const withBranch = toggleTableColumn(base, "branch", "project");
		expect(withBranch.columns).toContain("branch");
		expect(withBranch.columns.indexOf("branch")).toBeGreaterThan(withBranch.columns.indexOf("activity"));
		expect(toggleTableColumn(withBranch, "branch", "project").columns).not.toContain("branch");
	});

	it("never removes the title", () => {
		const base = defaultTableLayout("project");
		expect(toggleTableColumn(base, "title", "project")).toEqual(base);
	});
});

describe("laneOfTask", () => {
	it("puts a task with a custom column in that lane, otherwise in its status lane", () => {
		expect(laneOfTask(task({ status: "in-progress" }), columns)).toBe(1);
		expect(laneOfTask(task({ status: "in-progress", customColumnId: "c-review" }), columns)).toBe(2);
		expect(laneOfTask(task({ status: "cancelled" }), columns)).toBe(-1);
	});
});

describe("sortTableTasks", () => {
	const a = task({ id: "a", seq: 3, title: "banana", status: "completed", priority: "P2", agentId: "a2", projectId: "p2",
		createdAt: "2026-10-03T00:00:00Z", branchName: "feat/b", labelIds: ["x", "y"], prNumber: 12 });
	const b = task({ id: "b", seq: 1, title: "Apple", status: "todo", priority: "P0", agentId: "a1", projectId: "p1",
		createdAt: "2026-10-01T00:00:00Z", branchName: null, origin: { kind: "task", taskId: "parent1", projectId: "p1" } });
	const c = task({ id: "c", seq: 2, title: "cherry", status: "in-progress", customColumnId: "c-review", agentId: null,
		createdAt: "2026-10-02T00:00:00Z", branchName: "feat/a", labelIds: ["x"], origin: { kind: "task", taskId: "parent2", projectId: "p1" } });
	const all = [a, b, c];
	const ids = (sort: Parameters<typeof sortTableTasks>[1]) => sortTableTasks(all, sort, ctx).map((t) => t.id);

	it("sorts by seq both ways", () => {
		expect(ids(["seq", "asc"])).toEqual(["b", "c", "a"]);
		expect(ids(["seq", "desc"])).toEqual(["a", "c", "b"]);
	});

	it("orders variants of one seq by attempt number", () => {
		const v2 = task({ id: "v2", seq: 7, variantIndex: 2 });
		const v1 = task({ id: "v1", seq: 7, variantIndex: 1 });
		expect(sortTableTasks([v2, v1], ["seq", "asc"], ctx).map((t) => t.id)).toEqual(["v1", "v2"]);
		expect(sortTableTasks([v2, v1], ["title", "asc"], ctx).map((t) => t.id)).toEqual(["v1", "v2"]);
	});

	it("sorts titles case-insensitively", () => {
		expect(ids(["title", "asc"])).toEqual(["b", "a", "c"]);
	});

	it("sorts status by board lane order", () => {
		expect(ids(["status", "asc"])).toEqual(["b", "c", "a"]);
	});

	it("sorts priority by urgency, P0 first, missing as the default priority", () => {
		expect(ids(["priority", "asc"])).toEqual(["b", "a", "c"]);
	});

	it("sorts by agent name, project name, label names, PR, branch, parent seq and created", () => {
		expect(ids(["agent", "asc"])).toEqual(["b", "a", "c"]);
		expect(ids(["project", "asc"])).toEqual(["c", "b", "a"]);
		// a has "Alpha, Bug", c has "Bug"; b has none and goes last.
		expect(ids(["labels", "asc"])).toEqual(["a", "c", "b"]);
		expect(ids(["labels", "desc"])).toEqual(["c", "a", "b"]);
		expect(ids(["pr", "desc"])[0]).toBe("a");
		expect(ids(["branch", "asc"])).toEqual(["c", "a", "b"]);
		expect(ids(["parent", "asc"])).toEqual(["c", "b", "a"]);
		expect(ids(["created", "desc"])).toEqual(["a", "c", "b"]);
	});

	it("keeps empty values last in both directions", () => {
		const idle = task({ id: "idle", seq: 9, createdAt: "" });
		expect(sortTableTasks([idle, ...all], ["activity", "asc"], ctx).map((t) => t.id).pop()).toBe("idle");
		expect(ids(["branch", "desc"])).toEqual(["a", "c", "b"]);
		expect(ids(["agent", "desc"])).toEqual(["a", "b", "c"]);
	});

	it("breaks ties by seq descending and does not mutate its input", () => {
		const twins = [task({ id: "x", seq: 1 }), task({ id: "y", seq: 9 })];
		expect(sortTableTasks(twins, ["title", "asc"], ctx).map((t) => t.id)).toEqual(["y", "x"]);
		expect(twins.map((t) => t.id)).toEqual(["x", "y"]);
	});
});
