import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CWD_SCAN_TIMEOUT_MS, runLsof } from "../lsof-scan";
import { listPidCwds } from "../worktree-reaper";
import { spawn } from "../spawn";

const mockSpawn = vi.mocked(spawn);

function hungProc() {
	let exit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => (exit = resolve));
	const kill = vi.fn((signal: string) => {
		if (signal === "SIGTERM") exit(143);
	});
	return { pid: 0, stdout: new ReadableStream(), stderr: new ReadableStream(), exited, kill };
}

describe("runLsof", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("spawns lsof as its own process group on POSIX", async () => {
		mockSpawn.mockReturnValue({ pid: 0, stdout: "p1\n", stderr: "", exited: Promise.resolve(0), kill: vi.fn() } as never);
		await expect(runLsof(["-i"], 1_000)).resolves.toEqual({ stdout: "p1\n", exitCode: 0 });
		expect(mockSpawn).toHaveBeenCalledWith(["lsof", "-i"], expect.objectContaining({ detached: process.platform !== "win32" }));
	});

	it("reports a missing lsof as not measured", async () => {
		mockSpawn.mockImplementation(() => {
			throw new Error("posix_spawn ENOENT");
		});
		await expect(runLsof(["-i"], 1_000)).resolves.toBeNull();
	});

	it("listPidCwds reaps nothing from a cwd scan that timed out", async () => {
		const proc = hungProc();
		mockSpawn.mockReturnValue(proc as never);
		const cwds = listPidCwds();
		await vi.advanceTimersByTimeAsync(CWD_SCAN_TIMEOUT_MS + 1_000);
		await expect(cwds).resolves.toEqual(new Map());
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("listPidCwds keeps lsof output despite a non-zero exit", async () => {
		mockSpawn.mockReturnValue({ pid: 0, stdout: "p42\nn/tmp/wt\n", stderr: "", exited: Promise.resolve(1), kill: vi.fn() } as never);
		await expect(listPidCwds()).resolves.toEqual(new Map([[42, "/tmp/wt"]]));
	});
});
