import { digitBadgeById, digitTargets, mixedEntryId, resolveMixedOrder } from "../digitOrder";
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

const fileOf = (spaces: Space[], mixedOrder?: string[]): SpacesFile => ({
	version: 1,
	spaces,
	order: spaces.map((s) => s.id),
	...(mixedOrder ? { mixedOrder } : {}),
});

const ids = (entries: ReturnType<typeof resolveMixedOrder>) => entries.map(mixedEntryId);

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
		expect(ids(resolveMixedOrder(projects, file))).toEqual(["dev-3.0", "chisim", "hands.ru", "Nerd-Dictum"]);
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
	it("off: ordinary projects in board order, Operations and deleted ones excluded, capped at nine", () => {
		const ops = proj("ops", { kind: "virtual", builtin: true });
		const projects = [ops, proj("x", { deleted: true }), ...board, proj("extra")];
		const targets = digitTargets(projects, fileOf([hands]), false);
		expect(targets).toHaveLength(9);
		expect(targets.every((t) => t.kind === "project")).toBe(true);
		expect(ids(targets)).toEqual(names);
	});

	it("on: the first nine mixed entries", () => {
		const many = Array.from({ length: 12 }, (_, i) => proj(`p${i}`));
		expect(ids(digitTargets(many, fileOf([]), true))).toEqual(many.slice(0, 9).map((p) => p.id));
		expect(ids(digitTargets(board, fileOf([hands]), true))).toEqual(["chisim", "polymarket", "hands.ru", "Nerd-Dictum", "dev-3.0"]);
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
