import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => [{ id: "p1" }]),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => [
		{ id: "aaaaaaaa-1", title: "Small", worktreePath: "/w/small" },
		{ id: "bbbbbbbb-2", title: "Big", worktreePath: "/w/big" },
		{ id: "cccccccc-3", title: "Gone", worktreePath: "/w/gone" },
		{ id: "dddddddd-4", title: "Draft", worktreePath: null },
	]),
}));

import { spawn } from "../spawn";
import { scanWorktreeDiskUsage } from "../worktree-disk-usage";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockSpawn.mockReset();
	// /w/gone vanished: du skips it (and exits non-zero), the rest still counts.
	mockSpawn.mockReturnValue({ stdout: "10\t/w/small\n2048\t/w/big\n", exited: Promise.resolve(1) });
});

describe("scanWorktreeDiskUsage", () => {
	it("sizes every task worktree with one du, largest first, and serves repeats from cache", async () => {
		const rows = await scanWorktreeDiskUsage();
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(mockSpawn.mock.calls[0][0]).toEqual(["du", "-sk", "/w/small", "/w/big", "/w/gone"]);
		expect(rows.map((r) => [r.shortId, r.title, r.projectId, r.bytes])).toEqual([
			["bbbbbbbb", "Big", "p1", 2048 * 1024],
			["aaaaaaaa", "Small", "p1", 10 * 1024],
		]);

		await scanWorktreeDiskUsage();
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});
