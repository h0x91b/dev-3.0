import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/spaces-data`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME,
	OPS_DIR: `${DEV3_HOME}/ops`,
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

const SPACES_FILE = `${DEV3_HOME}/spaces.json`;

beforeEach(async () => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
	const { _resetSpacesCache } = await import("../spaces-data");
	_resetSpacesCache();
});

import {
	SpaceValidationError,
	createSpace,
	deleteSpace,
	loadSpacesFile,
	renameSpace,
	reorderSpaceProjects,
	reorderSpaces,
	setProjectSpaces,
	setSpaceSensitive,
} from "../spaces-data";
import type { SpacesFile } from "../../shared/types";

describe("loadSpacesFile", () => {
	it("returns the empty file shape when spaces.json is missing, without creating it", async () => {
		const file = await loadSpacesFile();
		expect(file).toEqual({ version: 1, spaces: [], order: [] });
		expect(existsSync(SPACES_FILE)).toBe(false);
	});
});

describe("createSpace", () => {
	it("persists, appends to order, and rejects empty name or membership", async () => {
		await expect(createSpace("X", [])).rejects.toBeInstanceOf(SpaceValidationError);
		await expect(createSpace("  ", ["p1"])).rejects.toBeInstanceOf(SpaceValidationError);
		const s = await createSpace("Client X", ["p1"]);
		expect(s.id).toMatch(/^sp_/);
		expect(s.parentId).toBeNull();
		const file = await loadSpacesFile();
		expect(file.spaces[0].projectIds).toEqual(["p1"]);
		expect(file.order).toEqual([s.id]);
	});

	it("dedupes project ids while keeping their order", async () => {
		const s = await createSpace("A", ["p1", "p2", "p1"]);
		expect(s.projectIds).toEqual(["p1", "p2"]);
	});
});

describe("setProjectSpaces", () => {
	it("adds and removes edges, appending on add", async () => {
		const a = await createSpace("A", ["p0"]);
		const b = await createSpace("B", ["p0"]);
		await setProjectSpaces("p1", [a.id]);
		expect((await loadSpacesFile()).spaces.find((s) => s.id === a.id)!.projectIds).toEqual(["p0", "p1"]);
		await setProjectSpaces("p1", [b.id]);
		const file = await loadSpacesFile();
		expect(file.spaces.find((s) => s.id === a.id)!.projectIds).toEqual(["p0"]);
		expect(file.spaces.find((s) => s.id === b.id)!.projectIds).toEqual(["p0", "p1"]);
	});

	it("auto-soft-deletes a space when its last member leaves and reports it", async () => {
		const a = await createSpace("A", ["p1"]);
		const { autoDeleted, file } = await setProjectSpaces("p1", []);
		expect(autoDeleted.map((s) => s.id)).toEqual([a.id]);
		expect(file.spaces.find((s) => s.id === a.id)!.deleted).toBe(true);
		expect(file.order).toEqual([]);
	});

	it("ignores unknown and deleted space ids in the requested set", async () => {
		const a = await createSpace("A", ["p0"]);
		const { file } = await setProjectSpaces("p1", ["sp_ghost", a.id]);
		expect(file.spaces.find((s) => s.id === a.id)!.projectIds).toEqual(["p0", "p1"]);
		expect(file.spaces).toHaveLength(1);
	});
});

describe("deleteSpace", () => {
	it("soft-deletes and keeps the record on disk", async () => {
		const a = await createSpace("A", ["p1"]);
		await deleteSpace(a.id);
		const raw = JSON.parse(readFileSync(SPACES_FILE, "utf8")) as SpacesFile;
		expect(raw.spaces[0].deleted).toBe(true);
		expect(raw.order).toEqual([]);
	});

	it("is idempotent", async () => {
		const a = await createSpace("A", ["p1"]);
		await deleteSpace(a.id);
		await expect(deleteSpace(a.id)).resolves.toBeUndefined();
	});
});

describe("dangling project ids", () => {
	it("persist untouched — skipping them is the renderer's job", async () => {
		await createSpace("A", ["ghost", "p1"]);
		expect((await loadSpacesFile()).spaces[0].projectIds).toEqual(["ghost", "p1"]);
	});
});

describe("reordering", () => {
	it("reorderSpaces persists order and appends omitted active ids", async () => {
		const a = await createSpace("A", ["p1", "p2"]);
		const b = await createSpace("B", ["p1"]);
		const c = await createSpace("C", ["p2"]);
		expect((await reorderSpaces([b.id, a.id])).order).toEqual([b.id, a.id, c.id]);
	});

	it("reorderSpaces drops ids of unknown or deleted spaces", async () => {
		const a = await createSpace("A", ["p1"]);
		expect((await reorderSpaces(["sp_ghost", a.id])).order).toEqual([a.id]);
	});

	it("reorderSpaceProjects reorders members and never adds new ones", async () => {
		const a = await createSpace("A", ["p1", "p2", "p3"]);
		expect((await reorderSpaceProjects(a.id, ["p2", "p9", "p1"])).projectIds).toEqual(["p2", "p1", "p3"]);
	});
});

describe("setSpaceSensitive", () => {
	it("sets the flag and removes it again, rather than writing false", async () => {
		const created = await createSpace("A", ["p1"]);
		expect((await setSpaceSensitive(created.id, true)).sensitive).toBe(true);
		// Absent, not `false`: an older app version reading this file treats a
		// missing key exactly the same, and the file stays minimal.
		const off = await setSpaceSensitive(created.id, false);
		expect("sensitive" in off).toBe(false);
		expect((await loadSpacesFile()).spaces[0].sensitive).toBeUndefined();
	});
});

describe("renameSpace and caching", () => {
	it("renames, invalidating the read cache", async () => {
		const created = await createSpace("A", ["p1"]);
		await loadSpacesFile();
		const renamed = await renameSpace(created.id, "A2");
		expect(renamed.name).toBe("A2");
		expect((await loadSpacesFile()).spaces[0].name).toBe("A2");
	});

	it("rejects an empty rename", async () => {
		const created = await createSpace("A", ["p1"]);
		await expect(renameSpace(created.id, "  ")).rejects.toBeInstanceOf(SpaceValidationError);
	});
});
