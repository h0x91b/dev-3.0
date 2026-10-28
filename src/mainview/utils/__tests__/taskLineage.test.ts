import type { Project, Task, TaskLineageIndex, TaskLineageNode } from "../../../shared/types";
import { matchesTaskQuery, parseTaskQuery, type TaskQueryContext } from "../taskSearch";
import {
	buildTaskLineage,
	childrenFilterToken,
	childrenTokenRefs,
	lineageChildren,
	lineageParent,
	resolveChildrenValue,
	withChildrenToken,
} from "../taskLineage";

const DEV3 = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "dev-3.0" } as Project;
const BREW = { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "homebrew" } as Project;
const QA = { id: "cccccccc-0000-0000-0000-000000000003", name: "QA Fixture" } as Project;
const TWIN_A = { id: "dddddddd-0000-0000-0000-000000000004", name: "twin" } as Project;
const TWIN_B = { id: "eeeeeeee-0000-0000-0000-000000000005", name: "twin" } as Project;
const PROJECTS = [DEV3, BREW, QA, TWIN_A, TWIN_B];

function task(id: string, project: Project, seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id, seq, projectId: project.id, title: `Task ${seq}`, description: "", status: "todo",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null,
		agentId: null, configId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}
const childOf = (parent: Task) => ({ origin: { kind: "task" as const, taskId: parent.id, projectId: parent.projectId } });

function node(t: Task, project: Project): TaskLineageNode {
	return { id: t.id, projectId: t.projectId, projectName: project.name, seq: t.seq, variantIndex: t.variantIndex, status: t.status, title: t.title };
}

// Coordinator #1801 in dev-3.0 runs as two variants; variant 2 created #1802 here
// and #9 in homebrew; #1802 created #1803 (a grandchild).
const coordV1 = task("coord-v1", DEV3, 1801, { groupId: "g", variantIndex: 1 });
const coordV2 = task("coord-v2", DEV3, 1801, { groupId: "g", variantIndex: 2 });
const childHere = task("child-here", DEV3, 1802, childOf(coordV2));
const childBrew = task("child-brew", BREW, 9, childOf(coordV1));
const grandchild = task("grandchild", DEV3, 1803, childOf(childHere));
const unrelated = task("unrelated", DEV3, 1700);
const orphan = task("orphan", DEV3, 1804, { origin: { kind: "task", taskId: "gone", projectId: DEV3.id } });

const index: TaskLineageIndex = {
	nodes: [node(coordV1, DEV3), node(coordV2, DEV3), node(childHere, DEV3), node(childBrew, BREW), node(grandchild, DEV3), node(orphan, DEV3)],
	edges: [
		{ childId: childHere.id, parentId: coordV2.id },
		{ childId: childBrew.id, parentId: coordV1.id },
		{ childId: grandchild.id, parentId: childHere.id },
		{ childId: orphan.id, parentId: "gone" },
	],
};
const lineage = buildTaskLineage(index);

function ctxFor(t: Task, currentProjectId: string | null = DEV3.id): TaskQueryContext {
	return {
		labelNames: [], agentName: null, statusValues: ["todo"], priorityValue: "p3", taskType: "standard",
		spaceNames: null, hasPort: false, isHidden: false, isHibernated: false, isAttention: false, isKeptAlive: false,
		childrenRefs: childrenTokenRefs(t, lineage, PROJECTS, currentProjectId),
	};
}
const board = [coordV1, coordV2, childHere, childBrew, grandchild, unrelated, orphan];
const matching = (query: string, currentProjectId: string | null = DEV3.id) =>
	board.filter((t) => matchesTaskQuery(t, query, ctxFor(t, currentProjectId))).map((t) => t.id);

describe("children: search token", () => {
	it("bare seq selects the parent group plus its direct children from every project, not grandchildren", () => {
		expect(matching("children:1801")).toEqual(["coord-v1", "coord-v2", "child-here", "child-brew"]);
	});

	it("project/seq names a parent in any project, by name or by id prefix", () => {
		expect(matching("children:dev-3.0/1801", BREW.id)).toEqual(["coord-v1", "coord-v2", "child-here", "child-brew"]);
		expect(matching("children:aaaaaaaa/1801", null)).toEqual(["coord-v1", "coord-v2", "child-here", "child-brew"]);
		expect(matching("children:homebrew/9", null)).toEqual(["child-brew"]);
	});

	it("a bare seq with no current project matches nothing", () => {
		expect(matching("children:1801", null)).toEqual([]);
	});

	it("is exact: a prefix of the seq never selects the batch", () => {
		expect(matching("children:180")).toEqual([]);
	});

	it("ANDs with other facets", () => {
		expect(matching("children:1801 status:todo")).toHaveLength(4);
		expect(matching("children:1801 status:review")).toEqual([]);
	});

	it("parses a quoted project name with a spaced name", () => {
		expect(parseTaskQuery('children:"QA Fixture"/5 label:x').facets.children).toEqual(["qa fixture/5"]);
		const qaParent = task("qa-parent", QA, 5);
		expect(childrenTokenRefs(qaParent, lineage, PROJECTS, null)).toContain("qa fixture/5");
	});

	it("an ambiguous project name matches nothing and resolves as ambiguous", () => {
		const twinTask = task("twin-task", TWIN_A, 3);
		expect(childrenTokenRefs(twinTask, lineage, PROJECTS, null)).not.toContain("twin/3");
		expect(resolveChildrenValue("twin/3", PROJECTS, null)).toEqual({ kind: "ambiguous", name: "twin", projectIds: [TWIN_A.id, TWIN_B.id], seq: 3 });
	});
});

describe("lineage lookups", () => {
	it("a child resolves its exact parent variant; a gone parent is deleted; user tasks have none", () => {
		expect(lineageParent(childHere, lineage)).toMatchObject({ id: "coord-v2", seq: 1801, variantIndex: 2 });
		expect(lineageParent(orphan, lineage)).toBe("deleted");
		expect(lineageParent(unrelated, lineage)).toBeNull();
	});

	it("nothing reads as deleted before the index loads", () => {
		expect(lineageParent(orphan, buildTaskLineage({ nodes: [], edges: [] }))).toBe("deleted");
		expect(lineageParent(orphan, { loaded: false, nodeById: new Map(), childrenByGroup: new Map() })).toBeNull();
	});

	it("counts children across the whole variant group and every project", () => {
		expect(lineageChildren(coordV1, lineage).map((c) => c.id).sort()).toEqual(["child-brew", "child-here"]);
		expect(lineageChildren(unrelated, lineage)).toEqual([]);
	});
});

describe("filter tokens from a click", () => {
	it("uses the bare seq at home, the quoted name elsewhere, the id when the name is ambiguous", () => {
		expect(childrenFilterToken({ projectId: DEV3.id, seq: 1801 }, PROJECTS, DEV3.id)).toBe("children:1801");
		expect(childrenFilterToken({ projectId: DEV3.id, seq: 1801 }, PROJECTS, BREW.id)).toBe("children:dev-3.0/1801");
		expect(childrenFilterToken({ projectId: QA.id, seq: 5 }, PROJECTS, null)).toBe('children:"QA Fixture"/5');
		expect(childrenFilterToken({ projectId: TWIN_A.id, seq: 3 }, PROJECTS, null)).toBe("children:dddddddd/3");
	});

	it("every generated token round-trips through the parser", () => {
		for (const token of ["children:1801", 'children:"QA Fixture"/5', "children:dddddddd/3"]) {
			const [value] = parseTaskQuery(token).facets.children;
			expect(resolveChildrenValue(value, PROJECTS, DEV3.id).kind).toBe("group");
		}
	});

	it("replaces an existing children: token and keeps the other facets", () => {
		expect(withChildrenToken('status:todo children:"QA Fixture"/5', "children:1801")).toBe("status:todo children:1801");
		expect(withChildrenToken("", "children:1801")).toBe("children:1801");
	});
});
