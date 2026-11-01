import type { Task } from "../../../../shared/types";
import type { BoardLineageNode } from "../../board-service";
import {
	buildTaskTree,
	expandableKeys,
	flattenTree,
	normalizeTreeLayout,
	toggleExpanded,
	type TreeNode,
} from "../tree-model";

function task(id: string, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: "p1", title: `Task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
		labelIds: [], ...overrides,
	} as Task;
}

const childOf = (parentId: string, projectId = "p1") => ({ origin: { kind: "task" as const, taskId: parentId, projectId } });

const outsideParent: BoardLineageNode = {
	id: "far", projectId: "p9", projectName: "Elsewhere", seq: 900, variantIndex: null, status: "in-progress", title: "Far parent",
};

function shape(nodes: readonly TreeNode[]): unknown[] {
	return nodes.map((node) => {
		const label = node.kind === "ghost" ? `ghost ${node.ref.seq}` : `${node.matches ? "" : "~"}${node.key}`;
		return node.children.length ? [label, shape(node.children)] : label;
	});
}

describe("buildTaskTree", () => {
	it("nests tasks under their lineage origin, newest first", () => {
		const tasks = [task("a", 1), task("b", 2, childOf("a")), task("c", 3, childOf("a")), task("d", 4, childOf("c")), task("e", 5)];
		const roots = buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => null });
		expect(shape(roots)).toEqual(["p1#5", ["p1#1", [["p1#3", ["p1#4"]], "p1#2"]]]);
	});

	it("collapses variants into one node, and children of any variant hang under it", () => {
		const tasks = [
			task("v1", 7, { groupId: "g", variantIndex: 1 }),
			task("v2", 7, { groupId: "g", variantIndex: 2 }),
			task("kid", 8, childOf("v2")),
		];
		const roots = buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => null });
		expect(shape(roots)).toEqual([["p1#7", ["p1#8"]]]);
		expect(roots[0].kind === "task" && roots[0].tasks.map((t) => t.id)).toEqual(["v1", "v2"]);
	});

	it("shows a parent from another project as a ghost root", () => {
		const tasks = [task("a", 1, childOf("far", "p9")), task("b", 2, childOf("far", "p9"))];
		const roots = buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: (id) => (id === "far" ? outsideParent : null) });
		expect(shape(roots)).toEqual([["ghost 900", ["p1#2", "p1#1"]]]);
		expect(roots[0]).toMatchObject({ kind: "ghost", key: "ghost:p9#900", matches: false });
	});

	it("draws no ghost while the lineage index loads, nor for a deleted parent", () => {
		const tasks = [task("a", 1, childOf("far", "p9"))];
		expect(shape(buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => null }))).toEqual(["p1#1"]);
		expect(shape(buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => "deleted" }))).toEqual(["p1#1"]);
	});

	it("keeps a non-matching ancestor as context and drops non-matching leaves", () => {
		const scope = [task("a", 1), task("b", 2, childOf("a")), task("c", 3)];
		const roots = buildTaskTree({ tasks: [scope[1]], scopeTasks: scope, lineageNode: () => null });
		expect(shape(roots)).toEqual([["~p1#1", ["p1#2"]]]);
	});

	it("survives an origin cycle", () => {
		const tasks = [task("a", 1, childOf("b")), task("b", 2, childOf("a"))];
		const roots = buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => null });
		const count = (list: readonly TreeNode[]): number => list.reduce((n, node) => n + 1 + count(node.children), 0);
		expect(count(roots)).toBe(2);
	});
});

describe("flattenTree", () => {
	const tasks = [task("a", 1), task("b", 2, childOf("a")), task("c", 3, childOf("b"))];
	const roots = buildTaskTree({ tasks, scopeTasks: tasks, lineageNode: () => null });

	it("is collapsed by default and counts what is inside", () => {
		const rows = flattenTree(roots, new Set(), { revealMatches: false });
		expect(rows.map((r) => [r.node.key, r.expanded, r.descendantCount])).toEqual([["p1#1", false, 2]]);
	});

	it("walks only into expanded nodes, tracking depth and parent", () => {
		const rows = flattenTree(roots, new Set(["p1#1", "p1#2"]), { revealMatches: false });
		expect(rows.map((r) => [r.node.key, r.depth, r.parentIndex])).toEqual([["p1#1", 0, -1], ["p1#2", 1, 0], ["p1#3", 2, 1]]);
	});

	it("opens context ancestors under a query unless the user closed them", () => {
		const filtered = buildTaskTree({ tasks: [tasks[2]], scopeTasks: tasks, lineageNode: () => null });
		expect(flattenTree(filtered, new Set(), { revealMatches: true }).map((r) => r.node.key)).toEqual(["p1#1", "p1#2", "p1#3"]);
		expect(flattenTree(filtered, new Set(), { revealMatches: true, closed: new Set(["p1#2"]) }).map((r) => r.node.key)).toEqual(["p1#1", "p1#2"]);
	});

	it("lists every expandable key for Expand all", () => {
		expect(expandableKeys(roots)).toEqual(["p1#1", "p1#2"]);
	});
});

describe("tree layout", () => {
	it("normalises anything stored into a collapsed default", () => {
		expect(normalizeTreeLayout(undefined)).toEqual({ groupBy: "none", expanded: [], lineageOnly: false });
		expect(normalizeTreeLayout({ expanded: ["a", 3, "a"], lineageOnly: true, groupBy: "bogus" }))
			.toEqual({ groupBy: "none", expanded: ["a"], lineageOnly: true });
	});

	it("toggles a key without duplicating it", () => {
		const open = toggleExpanded(normalizeTreeLayout(undefined), "k", true);
		expect(toggleExpanded(open, "k", true)).toBe(open);
		expect(toggleExpanded(open, "k", false).expanded).toEqual([]);
	});
});
