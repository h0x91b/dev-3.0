import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/board-view-state-data`);

vi.mock("../paths", () => ({ DEV3_HOME, OPS_DIR: `${DEV3_HOME}/ops` }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock("../data", () => ({
	getProject: vi.fn(async (id: string) => {
		if (id !== "p1") throw new Error(`Project not found: ${id}`);
		return { id: "p1", path: "/Users/me/src/app" };
	}),
}));

import { boardSavedViewsPath, boardViewStatePath, changeNamedBoardView, loadBoardViewState, saveBoardViewState } from "../board-view-state-data";
import { defaultBoardViewState, namedSavedViews, namedViewAddChange, withLayout, withViewType } from "../../shared/board-view-state";

beforeEach(() => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
});

describe("board view state on disk", () => {
	it("keeps a project's file in its existing data dir, next to tasks.json", async () => {
		expect(await boardViewStatePath({ kind: "project", id: "p1" })).toBe(`${DEV3_HOME}/data/Users-me-src-app/board-views.json`);
	});

	it("keeps a space's file in a new directory of its own", async () => {
		expect(await boardViewStatePath({ kind: "space", id: "sp_1" })).toBe(`${DEV3_HOME}/space-board-views/sp_1.json`);
	});

	it("refuses a space id that would leave that directory", async () => {
		await expect(boardViewStatePath({ kind: "space", id: "../../etc" })).rejects.toThrow(/Invalid space id/);
		await expect(boardSavedViewsPath({ kind: "space", id: "../../etc" })).rejects.toThrow(/Invalid space id/);
	});

	it("keeps named views in files of their own, beside the board-view files", async () => {
		expect(await boardSavedViewsPath({ kind: "project", id: "p1" })).toBe(`${DEV3_HOME}/data/Users-me-src-app/board-saved-views.json`);
		expect(await boardSavedViewsPath({ kind: "space", id: "sp_1" })).toBe(`${DEV3_HOME}/space-board-saved-views/sp_1.json`);
	});

	it("reads the default without writing anything when no file exists", async () => {
		expect(await loadBoardViewState({ kind: "project", id: "p1" })).toEqual(defaultBoardViewState());
		expect(existsSync(`${DEV3_HOME}/data`)).toBe(false);
	});

	it("round-trips a saved state", async () => {
		const state = withViewType(defaultBoardViewState(), "wide", "builtin:table");
		await saveBoardViewState({ kind: "space", id: "sp_1" }, state);
		expect(JSON.parse(readFileSync(`${DEV3_HOME}/space-board-views/sp_1.json`, "utf8"))).toEqual(state);
		expect(await loadBoardViewState({ kind: "space", id: "sp_1" })).toEqual(state);
	});

	it("treats a torn file as the default instead of failing the board", async () => {
		mkdirSync(`${DEV3_HOME}/space-board-views`, { recursive: true });
		writeFileSync(`${DEV3_HOME}/space-board-views/sp_1.json`, "{ not json");
		expect(await loadBoardViewState({ kind: "space", id: "sp_1" })).toEqual(defaultBoardViewState());
	});

	describe("named saved views", () => {
		const board = { kind: "space", id: "sp_1" } as const;

		it("keeps a named view another window saved when a stale copy is saved over it", async () => {
			const stale = defaultBoardViewState();
			const { state: added } = await changeNamedBoardView(board, namedViewAddChange(stale, "wide", "Done", "status:completed"));
			expect(namedSavedViews(added).map((view) => view.name)).toEqual(["Done"]);
			const saved = await saveBoardViewState(board, withLayout(stale, "wide", "builtin:kanban", { collapsed: ["todo"] }));
			expect(namedSavedViews(saved).map((view) => view.name)).toEqual(["Done"]);
			expect(namedSavedViews(await loadBoardViewState(board)).map((view) => view.name)).toEqual(["Done"]);
		});

		it("ignores named views a plain save carries, so a stale copy cannot resurrect a deleted one", async () => {
			const base = defaultBoardViewState();
			const change = namedViewAddChange(base, "wide", "Done", "");
			const { state: withDone } = await changeNamedBoardView(board, change);
			await changeNamedBoardView(board, { kind: "delete", id: change.view.id });
			const saved = await saveBoardViewState(board, withDone);
			expect(namedSavedViews(saved)).toEqual([]);
		});

		it("applies rename and update against the file as it is now", async () => {
			const base = withViewType(defaultBoardViewState(), "wide", "builtin:table");
			const change = namedViewAddChange(base, "wide", "Done", "a");
			await changeNamedBoardView(board, change);
			await changeNamedBoardView(board, { kind: "rename", id: change.view.id, name: " Shipped " });
			const { state: updated } = await changeNamedBoardView(board, { kind: "update", id: change.view.id, viewType: "builtin:tree", query: " b ", layouts: { "builtin:tree": { open: [] } } });
			expect(namedSavedViews(updated)).toEqual([{ id: change.view.id, name: "Shipped", viewType: "builtin:tree", query: "b", layouts: { "builtin:tree": { open: [] } } }]);
		});

		it("writes named views only to their own file, so an older build rewriting board-views.json cannot drop one", async () => {
			const change = namedViewAddChange(defaultBoardViewState(), "wide", "Done", "status:completed");
			await changeNamedBoardView(board, change);
			expect(existsSync(`${DEV3_HOME}/space-board-views/sp_1.json`)).toBe(false);
			expect(JSON.parse(readFileSync(`${DEV3_HOME}/space-board-saved-views/sp_1.json`, "utf8"))).toEqual({ version: 1, views: [change.view] });
			// What v1.64.0-v1.65.1 write: the whole file from a cache read before the view was saved.
			mkdirSync(`${DEV3_HOME}/space-board-views`, { recursive: true });
			writeFileSync(`${DEV3_HOME}/space-board-views/sp_1.json`, JSON.stringify(withViewType(defaultBoardViewState(), "wide", "builtin:table")));
			const state = await loadBoardViewState(board);
			expect(namedSavedViews(state)).toEqual([change.view]);
			expect(state.savedViews.find((view) => view.id === state.slots.wide)?.viewType).toBe("builtin:table");
		});

		it("never writes a named view into board-views.json, even when a save carries one", async () => {
			const { state } = await changeNamedBoardView(board, namedViewAddChange(defaultBoardViewState(), "wide", "Done", ""));
			await saveBoardViewState(board, state);
			const working = JSON.parse(readFileSync(`${DEV3_HOME}/space-board-views/sp_1.json`, "utf8"));
			expect(working.savedViews.every((view: { name: unknown }) => view.name === null)).toBe(true);
		});

		it("refuses a name another named view already has, ignoring case", async () => {
			const stale = defaultBoardViewState();
			const first = namedViewAddChange(stale, "wide", "Bugs", "");
			const other = namedViewAddChange(stale, "wide", "Other", "");
			await changeNamedBoardView(board, first);
			await changeNamedBoardView(board, other);
			const before = readFileSync(`${DEV3_HOME}/space-board-saved-views/sp_1.json`, "utf8");
			const added = await changeNamedBoardView(board, namedViewAddChange(stale, "wide", " bugs ", ""));
			expect(added.rejected).toBe("name-taken");
			expect(namedSavedViews(added.state).map((view) => view.name)).toEqual(["Bugs", "Other"]);
			const renamed = await changeNamedBoardView(board, { kind: "rename", id: other.view.id, name: "BUGS" });
			expect(renamed.rejected).toBe("name-taken");
			expect(readFileSync(`${DEV3_HOME}/space-board-saved-views/sp_1.json`, "utf8")).toBe(before);
			// A view may change the case of its own name.
			const own = await changeNamedBoardView(board, { kind: "rename", id: first.view.id, name: "BUGS" });
			expect(own.rejected).toBeNull();
			expect(namedSavedViews(own.state).map((view) => view.name)).toEqual(["BUGS", "Other"]);
		});

		it("a named view sharing an id with a working view stays on disk, and deleting it never touches the working view", async () => {
			mkdirSync(`${DEV3_HOME}/space-board-saved-views`, { recursive: true });
			const hidden = { id: "sv-default", name: "Hand edit", viewType: "builtin:table", query: "", layouts: {} };
			const kept = { id: "sv-named-1", name: "Kept", viewType: "builtin:table", query: "", layouts: {} };
			writeFileSync(`${DEV3_HOME}/space-board-saved-views/sp_1.json`, JSON.stringify({ version: 1, views: [hidden, kept] }));
			const state = await loadBoardViewState(board);
			expect(namedSavedViews(state)).toEqual([kept]);
			expect(state.savedViews.filter((view) => view.id === "sv-default")).toEqual([defaultBoardViewState().savedViews[0]]);
			const { state: next } = await changeNamedBoardView(board, { kind: "delete", id: "sv-default" });
			expect(next.savedViews.some((view) => view.id === "sv-default" && view.name === null)).toBe(true);
			expect(JSON.parse(readFileSync(`${DEV3_HOME}/space-board-saved-views/sp_1.json`, "utf8")).views).toEqual([kept]);
		});

		it("rejects malformed changes without touching the file's named views", async () => {
			const base = defaultBoardViewState();
			const change = namedViewAddChange(base, "wide", "Done", "");
			await changeNamedBoardView(board, change);
			for (const bad of [
				{ kind: "add", view: { ...change.view, name: "   " } },
				{ kind: "add", view: change.view },
				{ kind: "rename", id: change.view.id, name: 42 },
				{ kind: "update", id: change.view.id, viewType: "", query: "", layouts: {} },
				{ kind: "delete", id: "sv-default" },
				{ kind: "explode" },
			]) {
				await changeNamedBoardView(board, bad as never);
			}
			const state = await loadBoardViewState(board);
			expect(namedSavedViews(state)).toEqual([change.view]);
			expect(state.savedViews.some((view) => view.id === "sv-default")).toBe(true);
		});
	});
});
