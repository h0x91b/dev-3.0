/**
 * Host side of named saved views: concurrent named changes and plain saves against one
 * real file, with the real file lock (board-view-state-data.test.ts mocks it out).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/board-view-state-data-qa`);

vi.mock("../paths", () => ({ DEV3_HOME, OPS_DIR: `${DEV3_HOME}/ops` }));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => ({ id: "p1", path: "/Users/me/src/app" })),
}));

import { changeNamedBoardView, saveBoardViewState } from "../board-view-state-data";
import {
	activeSavedView,
	defaultBoardViewState,
	namedSavedViews,
	namedViewAddChange,
	withLayout,
	withViewType,
	type BoardViewState,
	type SavedBoardView,
} from "../../shared/board-view-state";

const board = { kind: "space", id: "sp_qa" } as const;
const file = `${DEV3_HOME}/space-board-views/sp_qa.json`;
const namedFile = `${DEV3_HOME}/space-board-saved-views/sp_qa.json`;
const onDisk = (): BoardViewState => JSON.parse(readFileSync(file, "utf8"));
const namedOnDisk = (): SavedBoardView[] => JSON.parse(readFileSync(namedFile, "utf8")).views;

function expectSlotsOnWorkingViews(state: BoardViewState) {
	for (const ff of ["wide", "narrow"] as const) expect(activeSavedView(state, ff).name).toBeNull();
}

beforeEach(() => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
});

describe("concurrent writers on one board file", () => {
	it("refuses the second of two windows saving one name at once", async () => {
		const stale = defaultBoardViewState();
		const results = await Promise.all([
			changeNamedBoardView(board, namedViewAddChange(stale, "wide", "Bugs", "a")),
			changeNamedBoardView(board, namedViewAddChange(stale, "wide", "bugs", "b")),
		]);
		expect(results.filter((r) => r.rejected === "name-taken")).toHaveLength(1);
		expect(namedOnDisk()).toHaveLength(1);
	});

	it("keeps all 20 named views added at once from two windows, interleaved with stale plain saves", async () => {
		const stale = withViewType(defaultBoardViewState(), "wide", "ext:list");
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			ops.push(changeNamedBoardView(board, namedViewAddChange(stale, "wide", `View ${i}`, `q${i}`)));
			ops.push(saveBoardViewState(board, withLayout(stale, "wide", "ext:list", { sort: String(i) })));
		}
		await Promise.all(ops);
		const names = namedOnDisk().map((v) => v.name).sort();
		expect(names).toEqual(Array.from({ length: 20 }, (_, i) => `View ${i}`).sort());
		expectSlotsOnWorkingViews(onDisk());
	});

	it("a delete racing a stale plain save that still carries the view stays deleted", async () => {
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Gone", "");
		const { state: withIt } = await changeNamedBoardView(board, add);
		await Promise.all([
			changeNamedBoardView(board, { kind: "delete", id: add.view.id }),
			saveBoardViewState(board, withLayout(withIt, "wide", "builtin:kanban", { collapsed: true })),
			saveBoardViewState(board, withIt),
		]);
		expect(namedOnDisk()).toEqual([]);
	});

	it("a plain save that carries a named view as a working view (same id) cannot rewrite or delete it", async () => {
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Keep", "q");
		await changeNamedBoardView(board, add);
		const hostile: BoardViewState = {
			version: 1,
			slots: { wide: add.view.id, narrow: add.view.id },
			savedViews: [{ id: add.view.id, name: null, viewType: "builtin:kanban", query: "", layouts: {} }],
		};
		const saved = await saveBoardViewState(board, hostile);
		// The presets file must still list "Keep", and the slots must still show a working view.
		expect(namedOnDisk()).toEqual([add.view]);
		expectSlotsOnWorkingViews(saved);
		expect(namedSavedViews(saved)).toEqual([]);
	});

});
