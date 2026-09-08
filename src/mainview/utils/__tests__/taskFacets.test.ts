import type { CodingAgent, Label, Task } from "../../../shared/types";
import {
	isAttentionTask,
	taskQueryContext,
	buildFilterGroups,
	type FacetResolver,
	type FilterFunnelOption,
} from "../taskFacets";

const claude: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [{ id: "c1", name: "Default" }],
	defaultConfigId: "c1",
};
const codex: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	configurations: [{ id: "x1", name: "Default" }],
	defaultConfigId: "x1",
};

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "Task",
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: "builtin-claude",
		configId: "c1",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const bugLabel: Label = { id: "l-bug", name: "Bug", color: "#ef4444" };
const featureLabel: Label = { id: "l-feat", name: "Feature", color: "#22c55e" };

describe("isAttentionTask", () => {
	it("is true for attention statuses", () => {
		expect(isAttentionTask(makeTask({ status: "user-questions" }))).toBe(true);
		expect(isAttentionTask(makeTask({ status: "review-by-user" }))).toBe(true);
	});

	it("is false for a working task", () => {
		expect(isAttentionTask(makeTask({ status: "in-progress" }))).toBe(false);
	});

	it("is true for every PR-review task", () => {
		expect(isAttentionTask(makeTask({ status: "review-by-colleague" }))).toBe(true);
	});
});

describe("taskQueryContext", () => {
	const resolver: FacetResolver = {
		agents: [claude, codex],
		labelsFor: () => [bugLabel],
		statusValuesFor: () => ["in-progress", "Agent is Working"],
		priorityFor: () => "P1",
		hasPortFor: () => true,
		isAttentionFor: () => false,
		prNumberFor: () => 123,
	};

	it("resolves each facet field from the resolver", () => {
		const c = taskQueryContext(makeTask(), resolver);
		expect(c.labelNames).toEqual(["Bug"]);
		expect(c.agentName).toBe("Claude");
		expect(c.statusValues).toEqual(["in-progress", "Agent is Working"]);
		expect(c.priorityValue).toBe("p1");
		expect(c.hasPort).toBe(true);
		expect(c.isAttention).toBe(false);
		expect(c.prNumber).toBe(123);
	});

	it("reports a null agent name when unassigned", () => {
		const c = taskQueryContext(makeTask({ agentId: null }), resolver);
		expect(c.agentName).toBeNull();
	});
});

describe("buildFilterGroups", () => {
	const statusCandidates: FilterFunnelOption[] = [
		{ facet: "status", value: "in-progress", label: "Agent is Working" },
		{ facet: "status", value: "review-by-user", label: "Your Review" },
		{ facet: "status", value: "On Hold", label: "On Hold", color: "#abcdef" },
	];
	const priorityCandidates: FilterFunnelOption[] = [
		{ facet: "priority", value: "P0", label: "P0 — Highest" },
		{ facet: "priority", value: "P1", label: "P1 — High" },
		{ facet: "priority", value: "P2", label: "P2 — Normal" },
		{ facet: "priority", value: "P3", label: "P3 — Low" },
		{ facet: "priority", value: "P4", label: "P4 — Lowest" },
	];
	const candidates = { priorityCandidates, statusCandidates, flagLabels: { attention: "Needs attention", port: "Has running port", home: "Home", hidden: "Hidden from sidebar" } };

	function resolverFor(): FacetResolver {
		const labelsById: Record<string, Label[]> = {
			working: [bugLabel],
			parked: [featureLabel],
		};
		const ports = new Set(["parked"]);
		return {
			agents: [claude, codex],
			labelsFor: (task) => labelsById[task.id] ?? [],
			statusValuesFor: (task) =>
				task.customColumnId === "col" ? ["On Hold", task.status, "Your Review"] : [task.status, "Agent is Working"],
			priorityFor: (task) => task.priority ?? "P2",
			hasPortFor: (task) => ports.has(task.id),
		isAttentionFor: (task) => isAttentionTask(task),
		};
	}

	it("leads with PRIORITY, lists only present values, hides empty groups, sorts labels/agents", () => {
		const tasks = [
			makeTask({ id: "working", status: "in-progress", priority: "P0", agentId: "builtin-codex", configId: "x1" }),
			makeTask({ id: "parked", status: "review-by-user", customColumnId: "col", agentId: "builtin-claude", configId: "c1" }),
		];
		const groups = buildFilterGroups(tasks, resolverFor(), candidates);
		// PRIORITY is the first group.
		expect(groups[0].id).toBe("priority");
		const byId = Object.fromEntries(groups.map((g) => [g.id, g.options]));

		// PRIORITY: only present levels (P0 explicit, P2 default), candidate order.
		expect(byId.priority.map((o) => o.value)).toEqual(["P0", "P2"]);
		// STATUS: only present canonical values, in candidate order. The parked
		// task reports "On Hold" (its column) as canonical, NOT "review-by-user".
		expect(byId.status.map((o) => o.value)).toEqual(["in-progress", "On Hold"]);
		// LABELS + AGENTS sorted alphabetically.
		expect(byId.labels.map((o) => o.label)).toEqual(["Bug", "Feature"]);
		expect(byId.agents.map((o) => o.label)).toEqual(["Claude", "Codex"]);
		// FLAGS: attention (the review task) + port (the parked task).
		expect(byId.flags.map((o) => `${o.facet}:${o.value}`)).toEqual(["is:attention", "has:port"]);
	});

	it("drops the FLAGS group entirely when no task is attention or has a port", () => {
		const tasks = [makeTask({ id: "working", status: "in-progress" })];
		const groups = buildFilterGroups(tasks, resolverFor(), candidates);
		expect(groups.find((g) => g.id === "flags")).toBeUndefined();
		expect(groups.find((g) => g.id === "status")?.options.map((o) => o.value)).toEqual(["in-progress"]);
	});

	it("returns no groups for an empty task list", () => {
		expect(buildFilterGroups([], resolverFor(), candidates)).toEqual([]);
	});
});

describe("buildFilterGroups — SPACES group", () => {
	const baseResolver: FacetResolver = {
		agents: [],
		labelsFor: () => [],
		statusValuesFor: (task) => [task.status],
		priorityFor: (task) => task.priority ?? "P2",
		hasPortFor: () => false,
		isAttentionFor: (task) => isAttentionTask(task),
	};
	const spaceCandidates = {
		priorityCandidates: [{ facet: "priority" as const, value: "P2", label: "P2 — Normal" }],
		statusCandidates: [{ facet: "status" as const, value: "in-progress", label: "Agent is Working" }],
		flagLabels: { attention: "Needs attention", port: "Has running port", home: "Home", hidden: "Hidden from sidebar" },
	};

	it("lists every space present in the pool, alphabetically, after STATUS", () => {
		const spacesByProject: Record<string, string[]> = {
			p1: ["Labs", "Client X"],
			p2: ["Client X"],
			p3: [],
		};
		const groups = buildFilterGroups(
			[
				makeTask({ id: "a", projectId: "p1" }),
				makeTask({ id: "b", projectId: "p2" }),
				makeTask({ id: "c", projectId: "p3" }),
			],
			{ ...baseResolver, spaceNamesFor: (task) => spacesByProject[task.projectId] ?? [] },
			spaceCandidates,
		);
		const ids = groups.map((g) => g.id);
		expect(ids).toContain("spaces");
		expect(ids.indexOf("spaces")).toBeGreaterThan(ids.indexOf("status"));
		const spaceGroup = groups.find((g) => g.id === "spaces")!;
		// p3 is in no space, so the computed Home option trails the real ones.
		expect(spaceGroup.options.map((o) => o.label)).toEqual(["Client X", "Labs", "Home"]);
		expect(spaceGroup.options.filter((o) => o.facet === "space").map((o) => o.value)).toEqual(["Client X", "Labs"]);
	});

	it("appends the computed Home option last when some project is in no space", () => {
		const spacesByProject: Record<string, string[]> = { p1: ["Labs"], p2: [] };
		const groups = buildFilterGroups(
			[makeTask({ id: "a", projectId: "p1" }), makeTask({ id: "b", projectId: "p2" })],
			{ ...baseResolver, spaceNamesFor: (task) => spacesByProject[task.projectId] ?? [] },
			spaceCandidates,
		);
		const spaceGroup = groups.find((g) => g.id === "spaces")!;
		expect(spaceGroup.options.map((o) => o.label)).toEqual(["Labs", "Home"]);
		const home = spaceGroup.options[spaceGroup.options.length - 1];
		// A flag token, so it can never collide with a space literally named Home.
		expect(home.facet).toBe("is");
		expect(home.value).toBe("home");
	});

	it("omits Home when every project belongs to a space", () => {
		const groups = buildFilterGroups(
			[makeTask({ id: "a", projectId: "p1" })],
			{ ...baseResolver, spaceNamesFor: () => ["Labs"] },
			spaceCandidates,
		);
		const spaceGroup = groups.find((g) => g.id === "spaces")!;
		expect(spaceGroup.options.map((o) => o.label)).toEqual(["Labs"]);
	});

	it("reports null space names where the surface cannot resolve them", () => {
		expect(taskQueryContext(makeTask(), baseResolver).spaceNames).toBeNull();
	});

	it("drops the group when the surface supplies no space resolver (single project board)", () => {
		const groups = buildFilterGroups([makeTask()], baseResolver, spaceCandidates);
		expect(groups.map((g) => g.id)).not.toContain("spaces");
	});

	it("puts the task's own spaces into the query context", () => {
		const c = taskQueryContext(makeTask({ projectId: "p1" }), {
			...baseResolver,
			spaceNamesFor: () => ["Client X"],
		});
		expect(c.spaceNames).toEqual(["Client X"]);
	});
});
