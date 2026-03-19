import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing resource-monitor
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	tmuxArgs: (socket: string, ...args: string[]) =>
		["tmux", "-L", socket, ...args],
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}));

vi.mock("../port-scanner", () => ({
	collectTaskPids: vi.fn(),
}));

import { startResourceMonitor, stopResourceMonitor, getResourceUsage } from "../resource-monitor";
import { spawnSync } from "../spawn";
import { collectTaskPids } from "../port-scanner";

const mockSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;
const mockCollectTaskPids = collectTaskPids as unknown as ReturnType<typeof vi.fn>;

function makeResult(stdout: string, exitCode = 0) {
	return {
		stdout: new TextEncoder().encode(stdout),
		stderr: new Uint8Array(),
		exitCode,
	};
}

describe("resource-monitor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawnSync.mockReset();
		mockCollectTaskPids.mockReset();
	});

	afterEach(() => {
		stopResourceMonitor();
		vi.useRealTimers();
	});

	it("getResourceUsage returns undefined when no data collected", () => {
		expect(getResourceUsage("task-123")).toBeUndefined();
	});

	it("polls and pushes resource usage after interval", async () => {
		const pids = new Set([100, 200, 300]);
		mockCollectTaskPids.mockReturnValue(pids);
		// pid=,rss=,%cpu= columns: pid rss cpu
		mockSpawnSync.mockReturnValue(makeResult("100   204800   5.2\n200   102400   2.1\n300    51200   0.5"));

		const push = vi.fn();
		const getSessions = vi.fn().mockReturnValue([
			{ taskId: "task-abc123", tmuxSocket: "dev3" },
		]);

		startResourceMonitor(push, getSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("resourceUsageUpdated", {
			taskId: "task-abc123",
			usage: expect.objectContaining({
				cpu: expect.any(Number),
				rss: expect.any(Number),
			}),
		});

		const usage = getResourceUsage("task-abc123");
		expect(usage).toBeDefined();
		// RSS: (204800 + 102400 + 51200) * 1024 = 358400 * 1024
		expect(usage!.rss).toBe(358400 * 1024);
		// CPU: 5.2 + 2.1 + 0.5 = 7.8
		expect(usage!.cpu).toBeCloseTo(7.8, 1);
	});

	it("does not push if change is below tolerance", async () => {
		const pids = new Set([100]);
		mockCollectTaskPids.mockReturnValue(pids);
		mockSpawnSync.mockReturnValue(makeResult("100   102400   5.0"));

		const push = vi.fn();
		const getSessions = vi.fn().mockReturnValue([
			{ taskId: "task-xyz", tmuxSocket: "dev3" },
		]);

		startResourceMonitor(push, getSessions);
		// First poll — should push
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll — tiny change (< 1% CPU and < 1MB RSS)
		mockSpawnSync.mockReturnValue(makeResult("100   102401   5.1"));
		await vi.advanceTimersByTimeAsync(10_000);
		// Should NOT push again (RSS delta ~1KB < 1MB, CPU delta 0.1 < 1%)
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("pushes again when CPU change exceeds tolerance", async () => {
		const pids = new Set([100]);
		mockCollectTaskPids.mockReturnValue(pids);
		mockSpawnSync.mockReturnValue(makeResult("100   102400   5.0"));

		const push = vi.fn();
		const getSessions = vi.fn().mockReturnValue([
			{ taskId: "task-cpu-jump", tmuxSocket: "dev3" },
		]);

		startResourceMonitor(push, getSessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// CPU jumps by >1%
		mockSpawnSync.mockReturnValue(makeResult("100   102400   15.0"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("skips session with no PIDs", async () => {
		mockCollectTaskPids.mockReturnValue(new Set());

		const push = vi.fn();
		const getSessions = vi.fn().mockReturnValue([
			{ taskId: "task-nopids", tmuxSocket: "dev3" },
		]);

		startResourceMonitor(push, getSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).not.toHaveBeenCalled();
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("cleans up stale cache for sessions no longer active", async () => {
		const pids = new Set([100]);
		mockCollectTaskPids.mockReturnValue(pids);
		mockSpawnSync.mockReturnValue(makeResult("100   102400   5.0"));

		const push = vi.fn();
		let sessions = [{ taskId: "task-gone", tmuxSocket: "dev3" }];
		const getSessions = vi.fn().mockImplementation(() => sessions);

		startResourceMonitor(push, getSessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("task-gone")).toBeDefined();

		// Remove session from active list
		sessions = [];
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("task-gone")).toBeUndefined();
	});
});
