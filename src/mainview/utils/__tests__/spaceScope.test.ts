import { spaceScopeProjectIds, spaceSiblingProjectIds } from "../spaceScope";
import type { Space } from "../../../shared/types";

const sp = (id: string, projectIds: string[], deleted = false): Space => ({
	id,
	name: id,
	parentId: null,
	projectIds,
	createdAt: 1,
	deleted,
});

describe("spaceSiblingProjectIds", () => {
	it("returns the deduplicated union across the project's spaces, including itself", () => {
		const spaces = [sp("a", ["p1", "p2"]), sp("b", ["p1", "p3"]), sp("c", ["p9"])];
		expect([...spaceSiblingProjectIds(spaces, "p1")!].sort()).toEqual(["p1", "p2", "p3"]);
	});

	it("returns null when the project belongs to no space", () => {
		expect(spaceSiblingProjectIds([sp("a", ["p2"])], "p1")).toBeNull();
		expect(spaceSiblingProjectIds([], "p1")).toBeNull();
	});

	it("ignores deleted spaces", () => {
		expect(spaceSiblingProjectIds([sp("a", ["p1"], true)], "p1")).toBeNull();
	});
});

describe("spaceScopeProjectIds", () => {
	// The whole point: p1 is in two spaces, so the union is the wrong pool — the
	// user is looking at exactly one of them.
	const twoSpaces = [sp("a", ["p1", "p2"]), sp("b", ["p1", "p3"])];

	it("narrows to the space on the route instead of the union", () => {
		expect([...spaceScopeProjectIds(twoSpaces, "p1", "a")!].sort()).toEqual(["p1", "p2"]);
		expect([...spaceScopeProjectIds(twoSpaces, "p1", "b")!].sort()).toEqual(["p1", "p3"]);
	});

	it("falls back to the union when the route names no space", () => {
		expect([...spaceScopeProjectIds(twoSpaces, "p1", null)!].sort()).toEqual(["p1", "p2", "p3"]);
	});

	it("falls back to the union rather than emptying the pool on a stale space id", () => {
		// Deleted, unknown, and "the project has since left it" all resolve the same
		// way: a route outliving its space must not narrow the sidebar to nothing.
		expect([...spaceScopeProjectIds([...twoSpaces, sp("gone", ["p1"], true)], "p1", "gone")!].sort())
			.toEqual(["p1", "p2", "p3"]);
		expect([...spaceScopeProjectIds(twoSpaces, "p1", "nope")!].sort()).toEqual(["p1", "p2", "p3"]);
		expect([...spaceScopeProjectIds([...twoSpaces, sp("c", ["p9"])], "p1", "c")!].sort())
			.toEqual(["p1", "p2", "p3"]);
	});

	it("is still null when the project belongs to no space at all", () => {
		expect(spaceScopeProjectIds([sp("a", ["p2"])], "p1", "a")).toBeNull();
	});
});
