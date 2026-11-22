import { dashboardProjectOrder, digitBadgeById, digitCandidates, digitPinPool, digitTargets, pinnedSlots, resolveDigitPins, type DigitSlot, isDigitTargetOnScreen, mixedEntryId, resolveMixedOrder, type MixedEntry } from "../digitOrder";
import type { Project, Space, SpacesFile } from "../../../shared/types";
import { groupProjectsForDashboard } from "../spaceGroups";

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

const fileOf = (spaces: Space[], mixedOrder?: string[]): SpacesFile => ({
	version: 1,
	spaces,
	order: spaces.map((s) => s.id),
	...(mixedOrder ? { mixedOrder } : {}),
});

const ids = (entries: DigitSlot[]) => entries.map((entry) => (entry ? mixedEntryId(entry) : null));

// The real board: one space "hands.ru" holding five of the nine projects.
const names = ["chisim", "polymarket", "bus", "pollex", "Nerd-Dictum", "voxscript", "ds_api", "dev-3.0", "aux"];
const board = names.map((n) => proj(n));
const hands = sp("hands.ru", ["bus", "pollex", "voxscript", "ds_api", "aux"]);

describe("resolveMixedOrder", () => {
	it("derives the order: a space takes the slot of its first member", () => {
		expect(ids(resolveMixedOrder(board, fileOf([hands])))).toEqual([
			"chisim",
			"polymarket",
			"hands.ru",
			"Nerd-Dictum",
			"dev-3.0",
		]);
	});

	it("keeps each space's own member order", () => {
		const entry = resolveMixedOrder(board, fileOf([hands])).find((e) => e.kind === "space");
		expect(entry?.kind === "space" && entry.projects.map((p) => p.id)).toEqual(["bus", "pollex", "voxscript", "ds_api", "aux"]);
	});

	it("with no spaces is the plain board order", () => {
		expect(ids(resolveMixedOrder(board, fileOf([])))).toEqual(names);
	});

	it("applies mixedOrder first and appends unlisted projects in derived order", () => {
		const file = fileOf([hands], ["dev-3.0", "hands.ru", "chisim"]);
		expect(ids(resolveMixedOrder(board, file))).toEqual(["dev-3.0", "hands.ru", "chisim", "polymarket", "Nerd-Dictum"]);
	});

	it("puts a project added after the reorder at the end, shifting no other digit", () => {
		const file = fileOf([hands], ["dev-3.0", "chisim", "polymarket", "hands.ru", "Nerd-Dictum"]);
		const withFresh = [...board, proj("fresh")];
		expect(ids(resolveMixedOrder(withFresh, file))).toEqual(["dev-3.0", "chisim", "polymarket", "hands.ru", "Nerd-Dictum", "fresh"]);
	});

	it("puts a new space in the slot its member held in the stored list", () => {
		const projects = ["bus", "chisim", "polymarket", "Nerd-Dictum"].map((n) => proj(n));
		const stored = ["polymarket", "Nerd-Dictum", "chisim", "bus"];
		const fresh = sp("sp_new", ["bus"]);
		expect(ids(resolveMixedOrder(projects, fileOf([fresh], stored)))).toEqual(["polymarket", "Nerd-Dictum", "chisim", "sp_new"]);
	});

	it("puts a new space made from several members in the earliest slot any of them held", () => {
		const projects = ["bus", "chisim", "polymarket", "Nerd-Dictum"].map((n) => proj(n));
		const stored = ["polymarket", "Nerd-Dictum", "chisim", "bus"];
		const fresh = sp("sp_new", ["chisim", "bus"]);
		expect(ids(resolveMixedOrder(projects, fileOf([fresh], stored)))).toEqual(["polymarket", "Nerd-Dictum", "sp_new"]);
	});

	it("ignores a deleted member's old slot when placing a new space", () => {
		const projects = ["a", "b", "c", "d"].map((n) => proj(n)).map((p) => (p.id === "b" ? { ...p, deleted: true } : p));
		const file = fileOf([sp("sp_x", ["b", "d"])], ["a", "b", "c", "d"]);
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["a", "c", "sp_x"]);
	});

	it("appends a new space none of whose members the stored list names", () => {
		const projects = ["a", "b", "c"].map((n) => proj(n));
		const file = fileOf([sp("sp_new", ["c"])], ["b", "a"]);
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["b", "a", "sp_new"]);
	});

	it("appends a project taken out of a space at the end", () => {
		const projects = ["a", "b", "c"].map((n) => proj(n));
		const file = fileOf([sp("sp_s", ["a"])], ["c", "sp_s"]);
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["c", "sp_s", "b"]);
	});

	it("skips stale ids: a deleted project, a deleted space, an unknown id", () => {
		const gone = sp("sp_gone", ["chisim"], { deleted: true });
		const projects = board.map((p) => (p.id === "polymarket" ? { ...p, deleted: true } : p));
		const file = fileOf([hands, gone], ["sp_gone", "polymarket", "ghost", "dev-3.0"]);
		// chisim was freed by the deleted space, so it takes that space's slot.
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["chisim", "dev-3.0", "hands.ru", "Nerd-Dictum"]);
	});

	it("gives the members of a deleted space that space's slot, in their board order", () => {
		const projects = ["a", "b", "c", "d", "e"].map((n) => proj(n));
		const web = sp("sp_web", ["b", "d"], { deleted: true });
		const file = fileOf([web], ["a", "sp_web", "c", "e"]);
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["a", "b", "d", "c", "e"]);
	});

	it("drops a space with no eligible member and frees nothing for it", () => {
		const empty = sp("sp_ghost", ["nobody"]);
		expect(ids(resolveMixedOrder(board, fileOf([empty])))).toEqual(names);
	});

	it("never lists the builtin Operations board, even as a space member", () => {
		const ops = proj("ops", { kind: "virtual", builtin: true });
		const entries = resolveMixedOrder([ops, ...board], fileOf([sp("sp_ops", ["ops", "chisim"])]));
		expect(ids(entries)).not.toContain("ops");
		const space = entries.find((e) => e.kind === "space");
		expect(space?.kind === "space" && space.projects.map((p) => p.id)).toEqual(["chisim"]);
	});

	it("lists a space once even when its members are scattered", () => {
		expect(ids(resolveMixedOrder(board, fileOf([hands]))).filter((id) => id === "hands.ru")).toHaveLength(1);
	});
});

describe("digitTargets", () => {
	it("off, no spaces: ordinary projects in board order, Operations and deleted ones excluded, capped at nine", () => {
		const ops = proj("ops", { kind: "virtual", builtin: true });
		const projects = [ops, proj("x", { deleted: true }), ...board, proj("extra")];
		const targets = digitTargets(projects, fileOf([]), false);
		expect(targets).toHaveLength(9);
		expect(targets.every((t) => t?.kind === "project")).toBe(true);
		expect(ids(targets)).toEqual(names);
	});

	it("off, with spaces: the dashboard's top-to-bottom order — space members first, then Home", () => {
		expect(ids(digitTargets(board, fileOf([hands]), false))).toEqual([
			"bus", "pollex", "voxscript", "ds_api", "aux", "chisim", "polymarket", "Nerd-Dictum", "dev-3.0",
		]);
	});

	it("off, with spaces: follows the rail order and each space's own member order", () => {
		const work = sp("work", ["gamma", "alpha"]);
		const media = sp("media", ["delta"]);
		const projects = ["alpha", "video-editor", "base44-debug", "gamma", "delta"].map((n) => proj(n));
		const file = { ...fileOf([work, media]), order: ["media", "work"] };
		expect(ids(digitTargets(projects, file, false))).toEqual(["delta", "gamma", "alpha", "video-editor", "base44-debug"]);
	});

	it("off: matches the groups the dashboard renders, a project in two spaces counted once", () => {
		const a = sp("a", ["pollex", "bus"]);
		const b = sp("b", ["bus", "chisim"]);
		const file = fileOf([a, b]);
		const rendered = (groupProjectsForDashboard(board, file) ?? []).flatMap((g) => g.projects.map((p) => p.id));
		const firstSeen = rendered.filter((id, i) => rendered.indexOf(id) === i);
		expect(dashboardProjectOrder(board, file).map((p) => p.id)).toEqual(firstSeen);
		expect(firstSeen.slice(0, 3)).toEqual(["pollex", "bus", "chisim"]);
	});

	it("off: a deleted space falls back out of the order", () => {
		const gone = sp("gone", ["dev-3.0"], { deleted: true });
		expect(ids(digitTargets(board, fileOf([gone]), false))).toEqual(names);
	});

	it("on: the first nine mixed entries", () => {
		const many = Array.from({ length: 12 }, (_, i) => proj(`p${i}`));
		expect(ids(digitTargets(many, fileOf([]), true))).toEqual(many.slice(0, 9).map((p) => p.id));
		expect(ids(digitTargets(board, fileOf([hands]), true))).toEqual(["chisim", "polymarket", "hands.ru", "Nerd-Dictum", "dev-3.0"]);
	});
});

describe("digitCandidates", () => {
	it("is the uncapped list digitTargets takes its nine from", () => {
		const many = Array.from({ length: 12 }, (_, i) => proj(`p${i}`));
		expect(ids(digitCandidates(many, fileOf([]), false))).toEqual(many.map((p) => p.id));
		expect(ids(digitCandidates(many, fileOf([]), true))).toHaveLength(12);
	});
});

describe("digit pins", () => {
	const pinned = (slots: (string | null)[], extra: Space[] = [hands]): SpacesFile => ({ ...fileOf(extra), digitSlots: slots });

	it("a pinned slot opens its pin and the others fill from the default order, skipping it", () => {
		// Off with a space: the default is the dashboard's grouped order, the space's members first.
		expect(ids(digitTargets(board, pinned([null, "aux"]), false))).toEqual(["bus", "aux", "pollex", "voxscript", "ds_api", "chisim", "polymarket", "Nerd-Dictum", "dev-3.0"]);
	});

	it("a project past the ninth can be pinned, pushing the last default entry off", () => {
		const many = Array.from({ length: 11 }, (_, i) => proj(`p${i}`));
		expect(ids(digitTargets(many, pinned(["p10"], []), false))).toEqual(["p10", "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
	});

	it("pins work in either mode: a space in project mode, a member project in spaces mode", () => {
		expect(ids(digitTargets(board, pinned(["hands.ru"]), false)).slice(0, 2)).toEqual(["hands.ru", "bus"]);
		expect(ids(digitTargets(board, pinned([null, null, null, null, null, "bus"]), true))).toEqual(["chisim", "polymarket", "hands.ru", "Nerd-Dictum", "dev-3.0", "bus"]);
	});

	it("keeps a pinned slot's position past the default list, leaving the gap empty", () => {
		const two = [proj("a"), proj("b"), proj("c")];
		expect(ids(digitTargets(two, pinned([null, null, null, null, "c"], []), false))).toEqual(["a", "b", null, null, "c"]);
	});

	it("a pin that no longer resolves (deleted project, Operations, unknown id) falls back to the default", () => {
		const projects = [proj("ops", { kind: "virtual", builtin: true }), proj("gone", { deleted: true }), proj("a"), proj("b")];
		expect(ids(digitTargets(projects, pinned(["gone", "ops", "zzz"], []), false))).toEqual(["a", "b"]);
		expect(resolveDigitPins(projects, pinned(["gone", "a"], []))).toEqual([null, { kind: "project", project: projects[2] }, null, null, null, null, null, null, null]);
	});

	it("the pool lists spaces with a live member first, then every ordinary project", () => {
		const empty = sp("empty", ["missing"]);
		expect(ids(digitPinPool(board, fileOf([hands, empty])))).toEqual(["hands.ru", ...names]);
	});
});

describe("pinnedSlots", () => {
	it("pins into nine slots and moves an id off any other slot it held", () => {
		expect(pinnedSlots(["a", "b"], 3, "a")).toEqual([null, "b", null, "a", null, null, null, null, null]);
	});

	it("null clears the slot", () => {
		expect(pinnedSlots(["a", "b"], 1, null)).toEqual(["a", null, null, null, null, null, null, null, null]);
	});
});

describe("digitBadgeById", () => {
	it("numbers targets from 1", () => {
		expect(digitBadgeById(digitTargets(board, fileOf([hands]), true))).toEqual({
			chisim: "1",
			polymarket: "2",
			"hands.ru": "3",
			"Nerd-Dictum": "4",
			"dev-3.0": "5",
		});
	});
});

describe("isDigitTargetOnScreen", () => {
	const a = proj("a");
	const b = proj("b");
	const c = proj("c");
	const projectA: MixedEntry = { kind: "project", project: a };
	const spaceBC: MixedEntry = { kind: "space", space: sp("s1", ["b", "c"]), projects: [b, c] };
	const otherSpace: MixedEntry = { kind: "space", space: sp("s2", ["a"]), projects: [a] };

	it("is true for the project board on screen, with or without a selected task", () => {
		expect(isDigitTargetOnScreen(projectA, { screen: "project", projectId: "a" })).toBe(true);
		expect(isDigitTargetOnScreen(projectA, { screen: "project", projectId: "a", activeTaskId: "t1" })).toBe(true);
	});

	it("is false on that project's full-page task, which is not a board", () => {
		expect(isDigitTargetOnScreen(projectA, { screen: "task", projectId: "a", taskId: "t1" })).toBe(false);
	});

	it("is false for another project", () => {
		expect(isDigitTargetOnScreen(projectA, { screen: "project", projectId: "b" })).toBe(false);
	});

	it("is false for a project while a space board containing it is on screen", () => {
		expect(isDigitTargetOnScreen(projectA, { screen: "project", projectId: "a", spaceId: "s2" })).toBe(false);
	});

	it("is true for a space target on its board, whichever member anchors it", () => {
		expect(isDigitTargetOnScreen(spaceBC, { screen: "project", projectId: "c", spaceId: "s1" })).toBe(true);
		expect(isDigitTargetOnScreen(spaceBC, { screen: "project", projectId: "b", spaceId: "s1", activeTaskId: "t1" })).toBe(true);
	});

	it("is false for a space target on another space or on a plain project board", () => {
		expect(isDigitTargetOnScreen(spaceBC, { screen: "project", projectId: "a", spaceId: "s2" })).toBe(false);
		expect(isDigitTargetOnScreen(otherSpace, { screen: "project", projectId: "a" })).toBe(false);
	});

	it("is false off the project screen", () => {
		expect(isDigitTargetOnScreen(projectA, { screen: "dashboard" })).toBe(false);
		expect(isDigitTargetOnScreen(spaceBC, { screen: "dashboard" })).toBe(false);
		expect(isDigitTargetOnScreen(spaceBC, { screen: "task", projectId: "b", taskId: "t1", spaceId: "s1" })).toBe(false);
	});
});
