/**
 * QA (independent) tests for the host side of named saved views: concurrent named
 * changes and plain saves against one real file, with the real file lock (the
 * author's data test replaces the lock with a pass-through).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/board-view-state-data-qa`);

vi.mock("../paths", () => ({ DEV3_HOME, OPS_DIR: `${DEV3_HOME}/ops` }));
vi.mock("../data", () => ({
	getProject: vi.fn(async () => ({ id: "p1", path: "/Users/me/src/app" })),
}));

import { changeNamedBoardView, loadBoardViewState, saveBoardViewState } from "../board-view-state-data";
import {
	activeSavedView,
	defaultBoardViewState,
	namedSavedViews,
	namedViewAddChange,
	withLayout,
	withViewType,
	type BoardViewState,
} from "../../shared/board-view-state";

const board = { kind: "space", id: "sp_qa" } as const;
const file = `${DEV3_HOME}/space-board-views/sp_qa.json`;
const onDisk = (): BoardViewState => JSON.parse(readFileSync(file, "utf8"));

function expectSlotsOnWorkingViews(state: BoardViewState) {
	for (const ff of ["wide", "narrow"] as const) expect(activeSavedView(state, ff).name).toBeNull();
}

beforeEach(() => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
});

describe("QA: concurrent writers on one board file", () => {
	it("keeps all 20 named views added at once from two windows, interleaved with stale plain saves", async () => {
		const stale = withViewType(defaultBoardViewState(), "wide", "ext:list");
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			ops.push(changeNamedBoardView(board, namedViewAddChange(stale, "wide", `View ${i}`, `q${i}`)));
			ops.push(saveBoardViewState(board, withLayout(stale, "wide", "ext:list", { sort: String(i) })));
		}
		await Promise.all(ops);
		const names = namedSavedViews(onDisk()).map((v) => v.name).sort();
		expect(names).toEqual(Array.from({ length: 20 }, (_, i) => `View ${i}`).sort());
		expectSlotsOnWorkingViews(onDisk());
	});

	it("a delete racing a stale plain save that still carries the view stays deleted", async () => {
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Gone", "");
		const withIt = await changeNamedBoardView(board, add);
		await Promise.all([
			changeNamedBoardView(board, { kind: "delete", id: add.view.id }),
			saveBoardViewState(board, withLayout(withIt, "wide", "builtin:kanban", { collapsed: true })),
			saveBoardViewState(board, withIt),
		]);
		expect(namedSavedViews(onDisk())).toEqual([]);
	});

	it("a plain save that carries a named view as a working view (same id) cannot hijack it", async () => {
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Keep", "q");
		await changeNamedBoardView(board, add);
		const hostile: BoardViewState = {
			version: 1,
			slots: { wide: add.view.id, narrow: add.view.id },
			savedViews: [{ id: add.view.id, name: null, viewType: "builtin:kanban", query: "", layouts: {} }],
		};
		const saved = await saveBoardViewState(board, hostile);
		// The file must still list "Keep", and the slots must still show a working view.
		expect(namedSavedViews(saved).map((v) => v.name)).toEqual(["Keep"]);
		expectSlotsOnWorkingViews(saved);
	});

	it("a named change on a torn file starts from the default and keeps the file valid", async () => {
		mkdirSync(`${DEV3_HOME}/space-board-views`, { recursive: true });
		writeFileSync(file, "{ torn");
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Fresh", "");
		await changeNamedBoardView(board, add);
		expect(namedSavedViews(await loadBoardViewState(board)).map((v) => v.name)).toEqual(["Fresh"]);
	});

	it("a change payload of the wrong shape leaves the file unchanged", async () => {
		const add = namedViewAddChange(defaultBoardViewState(), "wide", "Keep", "");
		await changeNamedBoardView(board, add);
		const before = readFileSync(file, "utf8");
		const junk: unknown[] = [
			{ kind: "add", view: null },
			{ kind: "add", view: { id: add.view.id, name: "Dup id" } },
			{ kind: "add", view: { id: "sv-default", name: "Working id" } },
			{ kind: "add", view: { id: "x", name: "   " } },
			{ kind: "update", id: add.view.id, viewType: 5, query: "", layouts: {} },
			{ kind: "update", id: add.view.id, viewType: "ext:list", query: "", layouts: [] },
			{ kind: "update", id: "sv-default", viewType: "ext:list", query: "", layouts: {} },
			{ kind: "rename", id: "sv-default", name: "Working" },
			{ kind: "rename", id: add.view.id, name: 7 },
			{ kind: "delete", id: "sv-default" },
			{ kind: "nuke" },
		];
		for (const change of junk) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await changeNamedBoardView(board, change as any);
		}
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(before));
	});
});
