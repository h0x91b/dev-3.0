import { describe, expect, it } from "vitest";
import {
	activeSavedView,
	cleanSavedViewName,
	defaultBoardViewState,
	isSafeBoardId,
	KANBAN_VIEW_ID,
	namedSavedViews,
	namedViewChangeTakesName,
	namedViewModified,
	normalizeBoardViewState,
	normalizeNamedViews,
	SAVED_VIEW_NAME_MAX,
	withLayout,
	withNamedViewAdded,
	withNamedViewApplied,
	withNamedViewRenamed,
	withNamedViewUpdated,
	withNamedViews,
	withoutNamedView,
	withViewType,
} from "../../shared/board-view-state";

describe("normalizeBoardViewState", () => {
	it("falls back to the default Kanban state for anything unreadable", () => {
		for (const raw of [null, 42, "x", [], { version: 2 }, { version: 1, savedViews: [] }]) {
			expect(normalizeBoardViewState(raw)).toEqual(defaultBoardViewState());
		}
	});

	it("re-points a slot whose saved view is missing", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "gone", narrow: "sv-a" },
			savedViews: [{ id: "sv-a", name: null, viewType: "builtin:table", query: "", layouts: {} }],
		});
		expect(state.slots).toEqual({ wide: "sv-a", narrow: "sv-a" });
	});

	it("drops malformed saved views and fills missing fields", () => {
		const state = normalizeBoardViewState({
			version: 1,
			slots: { wide: "sv-a", narrow: "sv-a" },
			savedViews: [{ nope: true }, { id: "sv-a" }],
		});
		expect(state.savedViews).toEqual([{ id: "sv-a", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} }]);
	});
});

describe("per-form-factor updates", () => {
	it("forks the shared saved view on the first change, leaving the other form factor alone", () => {
		const wide = withViewType(defaultBoardViewState(), "wide", "builtin:table");
		expect(activeSavedView(wide, "wide").viewType).toBe("builtin:table");
		expect(activeSavedView(wide, "narrow").viewType).toBe(KANBAN_VIEW_ID);
		expect(wide.savedViews).toHaveLength(2);
	});

	it("updates the forked view in place afterwards", () => {
		let state = withViewType(defaultBoardViewState(), "wide", "builtin:table");
		state = withLayout(state, "wide", "builtin:table", { sort: "seq" });
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

describe("named saved views", () => {
	const tableState = () => withLayout(withViewType(defaultBoardViewState(), "wide", "builtin:table"), "wide", "builtin:table", { columns: ["seq", "title"], sort: ["created", "desc"] });

	it("saves what the form factor shows plus the query, and keeps the slots on working views", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "  Done   this week ", " status:completed ");
		const named = namedSavedViews(state);
		expect(named).toEqual([{ id, name: "Done this week", viewType: "builtin:table", query: "status:completed", layouts: { "builtin:table": { columns: ["seq", "title"], sort: ["created", "desc"] } } }]);
		expect(activeSavedView(state, "wide").name).toBeNull();
		expect(activeSavedView(state, "narrow").name).toBeNull();
	});

	it("gives each named view a fresh id and copies layouts instead of sharing them", () => {
		const first = withNamedViewAdded(tableState(), "wide", "A", "");
		const second = withNamedViewAdded(first.state, "wide", "B", "");
		expect(second.id).not.toBe(first.id);
		const layout = activeSavedView(second.state, "wide").layouts["builtin:table"] as { columns: string[] };
		layout.columns.push("pr");
		expect((namedSavedViews(second.state)[0].layouts["builtin:table"] as { columns: string[] }).columns).toEqual(["seq", "title"]);
	});

	it("applies a named view to the working view of one form factor only", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "Done", "status:completed");
		const reset = withViewType(state, "wide", KANBAN_VIEW_ID);
		const applied = withNamedViewApplied(reset, "narrow", id);
		expect(activeSavedView(applied, "narrow").viewType).toBe("builtin:table");
		expect(activeSavedView(applied, "wide").viewType).toBe(KANBAN_VIEW_ID);
		expect(activeSavedView(applied, "narrow").name).toBeNull();
	});

	it("reports modified on a query, view type or layout change and clean after apply", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "Done", "status:completed");
		expect(namedViewModified(state, "wide", id, "status:completed ")).toBe(false);
		expect(namedViewModified(state, "wide", id, "status:review")).toBe(true);
		expect(namedViewModified(withViewType(state, "wide", KANBAN_VIEW_ID), "wide", id, "status:completed")).toBe(true);
		const resorted = withLayout(state, "wide", "builtin:table", { columns: ["seq", "title"], sort: ["seq", "asc"] });
		expect(namedViewModified(resorted, "wide", id, "status:completed")).toBe(true);
		expect(namedViewModified(withNamedViewApplied(resorted, "wide", id), "wide", id, "status:completed")).toBe(false);
	});

	it("ignores layouts of other view types when deciding modified", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "Done", "");
		const treeTouched = withLayout(state, "wide", "builtin:tree", { expanded: ["x"] });
		expect(namedViewModified(treeTouched, "wide", id, "")).toBe(false);
	});

	it("updates, renames and deletes only named views", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "Done", "status:completed");
		const changed = withViewType(state, "wide", KANBAN_VIEW_ID);
		const updated = withNamedViewUpdated(changed, "wide", id, "label:app");
		expect(namedSavedViews(updated)[0]).toMatchObject({ viewType: KANBAN_VIEW_ID, query: "label:app" });
		expect(namedSavedViews(withNamedViewRenamed(updated, id, "  Apps "))[0]?.name).toBe("Apps");
		expect(withNamedViewRenamed(updated, id, "   ")).toBe(updated);
		const workingId = activeSavedView(updated, "wide").id;
		expect(withoutNamedView(updated, workingId)).toBe(updated);
		expect(withNamedViewRenamed(updated, workingId, "x")).toBe(updated);
		expect(withNamedViewUpdated(updated, "wide", workingId, "x")).toBe(updated);
		expect(namedSavedViews(withoutNamedView(updated, id))).toEqual([]);
	});

	it("caps names", () => {
		expect(cleanSavedViewName("x".repeat(200))).toHaveLength(SAVED_VIEW_NAME_MAX);
	});

	it("survives a round trip through normalize, named views included", () => {
		const { state } = withNamedViewAdded(tableState(), "wide", "Done", "status:completed");
		expect(normalizeBoardViewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});

	it("never points a slot at a named view, adding a working view when none is left", () => {
		const onlyNamed = normalizeBoardViewState({
			version: 1,
			slots: { wide: "sv-named-1", narrow: "sv-named-1" },
			savedViews: [{ id: "sv-named-1", name: "Done", viewType: "builtin:table", query: "status:completed", layouts: {} }],
		});
		expect(activeSavedView(onlyNamed, "wide").name).toBeNull();
		expect(namedSavedViews(onlyNamed)).toHaveLength(1);
		const mixed = normalizeBoardViewState({
			version: 1,
			slots: { wide: "sv-named-1", narrow: "sv-default" },
			savedViews: [
				{ id: "sv-named-1", name: "Done", viewType: "builtin:table", query: "", layouts: {} },
				{ id: "sv-default", name: null, viewType: KANBAN_VIEW_ID, query: "", layouts: {} },
			],
		});
		expect(mixed.slots).toEqual({ wide: "sv-default", narrow: "sv-default" });
	});

	it("Revert clears a layout the saved view never had, so the view reads clean again", () => {
		const { state, id } = withNamedViewAdded(defaultBoardViewState(), "wide", "Mine", "");
		const collapsed = withLayout(state, "wide", KANBAN_VIEW_ID, { collapsed: ["todo"] });
		expect(namedViewModified(collapsed, "wide", id, "")).toBe(true);
		const reverted = withNamedViewApplied(collapsed, "wide", id);
		expect(activeSavedView(reverted, "wide").layouts).not.toHaveProperty(KANBAN_VIEW_ID);
		expect(namedViewModified(reverted, "wide", id, "")).toBe(false);
	});

	it("re-applying a view the board already shows changes nothing", () => {
		const { state, id } = withNamedViewAdded(tableState(), "wide", "Done", "");
		expect(withNamedViewApplied(state, "wide", id)).toBe(state);
	});

	it("never reuses an id, even after a delete", () => {
		const first = withNamedViewAdded(defaultBoardViewState(), "wide", "A", "");
		const second = withNamedViewAdded(withoutNamedView(first.state, first.id), "wide", "B", "");
		expect(second.id).not.toBe(first.id);
		expect(second.id).toMatch(/^sv-named-[0-9a-f]{16}$/);
	});

	it("withNamedViews takes the working views from the state and the named views from the list", () => {
		const disk = withNamedViewAdded(defaultBoardViewState(), "wide", "Disk", "").state;
		const client = withNamedViewAdded(tableState(), "wide", "Client", "").state;
		const merged = withNamedViews(client, namedSavedViews(disk));
		expect(namedSavedViews(merged).map((view) => view.name)).toEqual(["Disk"]);
		expect(activeSavedView(merged, "wide").viewType).toBe("builtin:table");
	});

	it("withNamedViews drops a named view that reuses a working view's id", () => {
		const hidden = { id: "sv-default", name: "Hand edit", viewType: "builtin:table", query: "", layouts: {} };
		const merged = withNamedViews(defaultBoardViewState(), [hidden]);
		expect(merged).toEqual(defaultBoardViewState());
	});

	it("normalizeNamedViews keeps named views only, first wins a repeated id or name", () => {
		const view = (id: string, name: unknown) => ({ id, name, viewType: "builtin:table", query: "", layouts: {} });
		expect(normalizeNamedViews(null)).toEqual([]);
		expect(normalizeNamedViews({ version: 2, views: [view("a", "A")] })).toEqual([]);
		const named = normalizeNamedViews({ version: 1, views: [view("a", " A "), view("a", "B"), view("b", "a"), view("c", null), view("d", "  "), view("e", "E"), 7] });
		expect(named.map((entry) => [entry.id, entry.name])).toEqual([["a", "A"], ["e", "E"]]);
	});

	it("refuses an add or rename that takes another named view's name, ignoring case", () => {
		const first = withNamedViewAdded(tableState(), "wide", "Bugs", "");
		const second = withNamedViewAdded(first.state, "wide", "Other", "");
		expect(namedSavedViews(withNamedViewAdded(second.state, "wide", " BUGS ", "").state)).toHaveLength(2);
		expect(withNamedViewRenamed(second.state, second.id, "bugs")).toBe(second.state);
		expect(namedViewChangeTakesName(second.state, { kind: "rename", id: first.id, name: "BUGS" })).toBe(false);
		expect(namedSavedViews(withNamedViewRenamed(second.state, first.id, "BUGS"))[0]?.name).toBe("BUGS");
	});
});
