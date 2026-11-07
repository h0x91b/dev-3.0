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

import { boardViewStatePath, loadBoardViewState, saveBoardViewState } from "../board-view-state-data";
import { defaultBoardViewState, withViewType } from "../../shared/board-view-state";

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
});
