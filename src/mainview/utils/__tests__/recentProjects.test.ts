import { beforeEach, describe, expect, it } from "vitest";
import { getProjectAccessTimes, getRecentProjectIds, orderByRecency, recordProjectJump } from "../recentProjects";

beforeEach(() => {
	localStorage.clear();
});

describe("recentProjects storage", () => {
	it("returns an empty list when nothing is stored", () => {
		expect(getRecentProjectIds()).toEqual([]);
	});

	it("records a jump at the front of the list", () => {
		recordProjectJump("a");
		recordProjectJump("b");
		expect(getRecentProjectIds()).toEqual(["b", "a"]);
	});

	it("moves a re-jumped project back to the front without duplicating", () => {
		recordProjectJump("a");
		recordProjectJump("b");
		recordProjectJump("a");
		expect(getRecentProjectIds()).toEqual(["a", "b"]);
	});

	it("ignores empty ids", () => {
		recordProjectJump("");
		expect(getRecentProjectIds()).toEqual([]);
	});

	it("caps the list at 16 entries, dropping the oldest", () => {
		for (let i = 0; i < 20; i++) recordProjectJump(`p${i}`);
		const ids = getRecentProjectIds();
		expect(ids).toHaveLength(16);
		expect(ids[0]).toBe("p19");
		expect(ids).not.toContain("p3");
	});

	it("tolerates corrupt storage", () => {
		localStorage.setItem("dev3-recent-projects-v1", "{not json");
		expect(getRecentProjectIds()).toEqual([]);
	});

	it("filters out non-string entries", () => {
		localStorage.setItem("dev3-recent-projects-v1", JSON.stringify(["a", 5, null, "b"]));
		expect(getRecentProjectIds()).toEqual(["a", "b"]);
	});
});

describe("project access times", () => {
	it("returns an empty map when nothing is stored", () => {
		expect(getProjectAccessTimes()).toEqual({});
	});

	it("stamps an access time on jump", () => {
		const before = Date.now();
		recordProjectJump("a");
		const times = getProjectAccessTimes();
		expect(times.a).toBeGreaterThanOrEqual(before);
		expect(times.a).toBeLessThanOrEqual(Date.now());
	});

	it("prunes access times for ids dropped past the cap", () => {
		for (let i = 0; i < 20; i++) recordProjectJump(`p${i}`);
		const times = getProjectAccessTimes();
		expect(Object.keys(times)).toHaveLength(16);
		expect(times.p19).toBeGreaterThan(0);
		expect(times.p0).toBeUndefined(); // dropped with the oldest ids
	});

	it("tolerates corrupt / non-numeric storage", () => {
		localStorage.setItem("dev3-recent-projects-at-v1", "{not json");
		expect(getProjectAccessTimes()).toEqual({});
		localStorage.setItem("dev3-recent-projects-at-v1", JSON.stringify({ a: 5, b: "x", c: null }));
		expect(getProjectAccessTimes()).toEqual({ a: 5 });
	});
});

describe("orderByRecency", () => {
	const projects = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

	it("keeps board order when there are no recent ids", () => {
		expect(orderByRecency(projects, []).map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("puts recent projects first (in MRU order), then the rest in board order", () => {
		expect(orderByRecency(projects, ["c", "a"]).map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
	});

	it("ignores recent ids that no longer exist", () => {
		expect(orderByRecency(projects, ["gone", "d"]).map((p) => p.id)).toEqual(["d", "a", "b", "c"]);
	});

	it("never duplicates a project even if the recent list has duplicates", () => {
		expect(orderByRecency(projects, ["b", "b"]).map((p) => p.id)).toEqual(["b", "a", "c", "d"]);
	});
});
