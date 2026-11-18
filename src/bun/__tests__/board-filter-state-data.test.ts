import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/board-filter-state-data`);

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

import { boardFilterStatePath, loadBoardFilterState, saveBoardFilterState } from "../board-filter-state-data";
import { normalizeBoardFilterState } from "../../shared/board-filter-state";

beforeEach(() => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
});

describe("board filter state on disk", () => {
	it("keeps a project's file in its existing data dir", async () => {
		expect(await boardFilterStatePath({ kind: "project", id: "p1" })).toBe(`${DEV3_HOME}/data/Users-me-src-app/board-filters.json`);
	});

	it("keeps a space's file in a new directory of its own", async () => {
		expect(await boardFilterStatePath({ kind: "space", id: "sp_1" })).toBe(`${DEV3_HOME}/space-board-filters/sp_1.json`);
	});

	it("refuses a space id that would leave that directory", async () => {
		await expect(boardFilterStatePath({ kind: "space", id: "../../etc" })).rejects.toThrow(/Invalid space id/);
	});

	it("reads the default without writing anything when no file exists", async () => {
		expect(await loadBoardFilterState({ kind: "project", id: "p1" })).toEqual({ visibility: "all" });
		expect(existsSync(`${DEV3_HOME}/data`)).toBe(false);
	});

	it("round-trips a saved visibility and writes only that", async () => {
		await saveBoardFilterState({ kind: "space", id: "sp_1" }, { visibility: "active" });
		expect(JSON.parse(readFileSync(`${DEV3_HOME}/space-board-filters/sp_1.json`, "utf8"))).toEqual({ visibility: "active" });
		expect(await loadBoardFilterState({ kind: "space", id: "sp_1" })).toEqual({ visibility: "active" });
	});

	it("reads a legacy statuses file as the default visibility", async () => {
		mkdirSync(`${DEV3_HOME}/space-board-filters`, { recursive: true });
		writeFileSync(`${DEV3_HOME}/space-board-filters/sp_1.json`, JSON.stringify({ statuses: ["todo"] }));
		expect(await loadBoardFilterState({ kind: "space", id: "sp_1" })).toEqual({ visibility: "all" });
	});

	it("treats a torn file as the default instead of failing the board", async () => {
		mkdirSync(`${DEV3_HOME}/space-board-filters`, { recursive: true });
		writeFileSync(`${DEV3_HOME}/space-board-filters/sp_1.json`, "{ not json");
		expect(await loadBoardFilterState({ kind: "space", id: "sp_1" })).toEqual({ visibility: "all" });
	});
});

describe("normalizeBoardFilterState", () => {
	it("keeps only the active visibility", () => {
		expect(normalizeBoardFilterState({ visibility: "active" })).toEqual({ visibility: "active" });
		expect(normalizeBoardFilterState({ visibility: "all" })).toEqual({ visibility: "all" });
	});

	it("falls back to all for any other shape", () => {
		expect(normalizeBoardFilterState(null)).toEqual({ visibility: "all" });
		expect(normalizeBoardFilterState({ visibility: "ACTIVE" })).toEqual({ visibility: "all" });
		expect(normalizeBoardFilterState({ statuses: ["todo"] })).toEqual({ visibility: "all" });
		expect(normalizeBoardFilterState("active")).toEqual({ visibility: "all" });
	});
});
