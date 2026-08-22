import { HOME_GROUP_ID, filterDashboardGroups, groupProjectsForDashboard, groupProjectsForSwitcher } from "../spaceGroups";
import type { Project, Space, SpacesFile } from "../../../shared/types";

const proj = (id: string, over?: Partial<Project>): Project => ({
	id,
	name: id,
	path: `/tmp/${id}`,
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	...over,
});

const sp = (id: string, projectIds: string[], over?: Partial<Space>): Space => ({
	id,
	name: id,
	parentId: null,
	projectIds,
	createdAt: 1,
	...over,
});

const fileOf = (spaces: Space[], order?: string[]): SpacesFile => ({
	version: 1,
	spaces,
	order: order ?? spaces.map((s) => s.id),
});

describe("groupProjectsForDashboard", () => {
	it("returns null when there are no active spaces", () => {
		expect(groupProjectsForDashboard([proj("a")], fileOf([]))).toBeNull();
		expect(groupProjectsForDashboard([proj("a")], fileOf([sp("sp_x", ["a"], { deleted: true })]))).toBeNull();
	});

	it("orders groups by the order array and projects by each space's projectIds", () => {
		const projects = [proj("a"), proj("b"), proj("c")];
		const file = fileOf([sp("sp_1", ["b", "a"]), sp("sp_2", ["c"])], ["sp_2", "sp_1"]);
		const groups = groupProjectsForDashboard(projects, file)!;
		expect(groups.map((g) => g.space?.id ?? "rest")).toEqual(["sp_2", "sp_1", "rest"]);
		expect(groups[1].projects.map((p) => p.id)).toEqual(["b", "a"]);
	});

	it("repeats a project under each of its spaces", () => {
		const projects = [proj("a"), proj("b")];
		const file = fileOf([sp("sp_1", ["a"]), sp("sp_2", ["a", "b"])]);
		const groups = groupProjectsForDashboard(projects, file)!;
		expect(groups[0].projects.map((p) => p.id)).toEqual(["a"]);
		expect(groups[1].projects.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("collects membership-less projects into the trailing null group, preserving input order", () => {
		const projects = [proj("z"), proj("a"), proj("m")];
		const file = fileOf([sp("sp_1", ["a"])]);
		const groups = groupProjectsForDashboard(projects, file)!;
		const rest = groups[groups.length - 1];
		expect(rest.space).toBeNull();
		expect(rest.projects.map((p) => p.id)).toEqual(["z", "m"]);
	});

	it("skips dangling project ids silently and drops a space with no resolvable member", () => {
		const projects = [proj("a")];
		const file = fileOf([sp("sp_1", ["ghost", "a"]), sp("sp_2", ["ghost-only"])]);
		const groups = groupProjectsForDashboard(projects, file)!;
		expect(groups.map((g) => g.space?.id ?? "rest")).toEqual(["sp_1", "rest"]);
		expect(groups[0].projects.map((p) => p.id)).toEqual(["a"]);
	});

	it("returns null when every space resolves to zero members (all dangling)", () => {
		expect(groupProjectsForDashboard([proj("a")], fileOf([sp("sp_1", ["ghost"])]))).toBeNull();
	});

	it("keeps the builtin Ops project out of every group including the bottom block", () => {
		const ops = proj("ops", { kind: "virtual", builtin: true });
		const projects = [ops, proj("a"), proj("b")];
		const file = fileOf([sp("sp_1", ["a"])]);
		const groups = groupProjectsForDashboard(projects, file)!;
		for (const g of groups) {
			expect(g.projects.some((p) => p.id === "ops")).toBe(false);
		}
	});
});

describe("filterDashboardGroups", () => {
	const projects = [proj("a"), proj("b"), proj("loose")];
	const spaces = [sp("sp_1", ["a"]), sp("sp_2", ["a", "b"])];
	const groups = () => groupProjectsForDashboard(projects, fileOf(spaces));

	it("passes null through (zero spaces keeps the legacy flat path)", () => {
		expect(filterDashboardGroups(null, { selectedSpaceId: null, query: "", spaces })).toBeNull();
	});

	it("keeps every group when nothing is selected or typed", () => {
		const out = filterDashboardGroups(groups(), { selectedSpaceId: null, query: "", spaces })!;
		expect(out.map((g) => g.space?.id ?? "home")).toEqual(["sp_1", "sp_2", "home"]);
	});

	it("narrows to one space when the rail selects it", () => {
		const out = filterDashboardGroups(groups(), { selectedSpaceId: "sp_2", query: "", spaces })!;
		expect(out).toHaveLength(1);
		expect(out[0].projects.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("narrows to the computed Home group", () => {
		const out = filterDashboardGroups(groups(), { selectedSpaceId: HOME_GROUP_ID, query: "", spaces })!;
		expect(out).toHaveLength(1);
		expect(out[0].space).toBeNull();
		expect(out[0].projects.map((p) => p.id)).toEqual(["loose"]);
	});

	it("filters rows by project name and drops groups left empty", () => {
		const out = filterDashboardGroups(groups(), { selectedSpaceId: null, query: "loose", spaces })!;
		expect(out).toHaveLength(1);
		expect(out[0].space).toBeNull();
	});

	it("keeps a whole group when the query matches its space name", () => {
		const named = [sp("sp_1", ["a"]), { ...sp("sp_2", ["a", "b"]), name: "Client X" }];
		const out = filterDashboardGroups(groupProjectsForDashboard(projects, fileOf(named)), {
			selectedSpaceId: null,
			query: "client",
			spaces: named,
		})!;
		// sp_2 matches by name and keeps both members; sp_1 keeps only `a`, whose
		// own haystack carries "Client X"; Home drops (no match at all).
		expect(out.map((g) => g.space?.id ?? "home")).toEqual(["sp_1", "sp_2"]);
		expect(out[0].projects.map((p) => p.id)).toEqual(["a"]);
		expect(out[1].projects.map((p) => p.id)).toEqual(["a", "b"]);
	});
});

describe("groupProjectsForSwitcher", () => {
	const projects = [proj("a"), proj("b"), proj("c"), proj("loose")];

	it("returns null when there are no active spaces", () => {
		expect(groupProjectsForSwitcher(projects, fileOf([]), "a")).toBeNull();
	});

	it("hoists every space holding the current project, keeping their relative order", () => {
		const file = fileOf([sp("sp_1", ["a"]), sp("sp_2", ["b", "c"]), sp("sp_3", ["c", "b"])]);
		const out = groupProjectsForSwitcher(projects, file, "b")!;
		expect(out.map((g) => g.space?.id ?? "home")).toEqual(["sp_2", "sp_3", "sp_1", "home"]);
	});

	it("leaves the order untouched when the current project has no space", () => {
		const file = fileOf([sp("sp_1", ["a"]), sp("sp_2", ["b"])]);
		const out = groupProjectsForSwitcher(projects, file, "loose")!;
		expect(out.map((g) => g.space?.id ?? "home")).toEqual(["sp_1", "sp_2", "home"]);
	});

	it("never hoists the Home group above real spaces", () => {
		const file = fileOf([sp("sp_1", ["a"])]);
		const out = groupProjectsForSwitcher(projects, file, "loose")!;
		expect(out[out.length - 1].space).toBeNull();
	});

	it("keeps dashboard order when there is no current project", () => {
		const file = fileOf([sp("sp_1", ["a"]), sp("sp_2", ["b"])]);
		const out = groupProjectsForSwitcher(projects, file, null)!;
		expect(out.map((g) => g.space?.id ?? "home")).toEqual(["sp_1", "sp_2", "home"]);
	});
});
