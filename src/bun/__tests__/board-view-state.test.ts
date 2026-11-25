import { describe, expect, it } from "vitest";
import {
	activeSavedView,
	defaultBoardViewState,
	isSafeBoardId,
	KANBAN_VIEW_ID,
	normalizeBoardViewState,
	withLayout,
	withViewType,
} from "../../shared/board-view-state";

describe("normalizeBoardViewState", () => {
	it("falls back to the default Kanban state for anything unreadable", () => {
		for (const raw of [null, 42, "x", [], { version: 2 }, { version: 1, savedViews: [] }]) {
			expect(normalizeBoardViewState(raw)).toEqual(defaultBoardViewState());
		}
	});

	it("re-points a slot whose saved view is missing, and drops malformed saved views", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "gone", narrow: "sv-a" },
			savedViews: [{ id: "sv-a", name: null, viewType: "builtin:table", query: "", layouts: {} }],
		});
		expect(state.slots).toEqual({ wide: "sv-a", narrow: "sv-a" });

		// Malformed saved views are dropped and missing fields filled.
		const filled = normalizeBoardViewState({
			version: 1,
			slots: { wide: "sv-a", narrow: "sv-a" },
			savedViews: [{ nope: true }, { id: "sv-a" }],
		});
		expect(filled.savedViews).toEqual([{ id: "sv-a", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} }]);
	});
});

describe("per-form-factor updates", () => {
	it("forks the shared saved view on the first change, then updates the fork in place", () => {
		const wide = withViewType(defaultBoardViewState(), "wide", "builtin:table");
		expect(activeSavedView(wide, "wide").viewType).toBe("builtin:table");
		expect(activeSavedView(wide, "narrow").viewType).toBe(KANBAN_VIEW_ID);
		expect(wide.savedViews).toHaveLength(2);

		// Afterwards the forked view is updated in place.
		let state = withLayout(wide, "wide", "builtin:table", { sort: "seq" });
		state = withViewType(state, "wide", "builtin:tree");
		expect(state.savedViews).toHaveLength(2);
		expect(activeSavedView(state, "wide")).toMatchObject({ viewType: "builtin:tree", layouts: { "builtin:table": { sort: "seq" } } });
		expect(activeSavedView(state, "narrow").layouts).toEqual({});
	});

	it("survives a normalize round trip", () => {
		const state = withLayout(defaultBoardViewState(), "narrow", KANBAN_VIEW_ID, { collapsed: ["completed"] });
		expect(normalizeBoardViewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});
});

describe("isSafeBoardId", () => {
	it("accepts generated space ids and refuses anything path-like", () => {
		expect(isSafeBoardId("sp_0b6f1f2e-1c1a-4a5e-9f4e-1b2c3d4e5f60")).toBe(true);
		for (const id of ["", "../x", "a/b", "a\\b", ".", "x".repeat(200)]) expect(isSafeBoardId(id)).toBe(false);
	});
});
