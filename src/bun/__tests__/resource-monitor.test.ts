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

import { startResourceMonitor, stopResourceMonitor, getResourceUsage, parsePsOutput } from "../resource-monitor";
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

describe("parsePsOutput", () => {
	it("parses multi-line ps output and sums RSS/CPU", () => {
		const output = "100   204800   5.2\n200   102400   2.1\n300    51200   0.5";
		const result = parsePsOutput(output);
		expect(result.rss).toBe(358400 * 1024);
		expect(result.cpu).toBeCloseTo(7.8, 1);
	});

	it("returns zeros for empty output", () => {
		expect(parsePsOutput("")).toEqual({ rss: 0, cpu: 0 });
	});

	it("handles leading whitespace", () => {
		const output = "  123  50000   3.0";
		const result = parsePsOutput(output);
		expect(result.rss).toBe(50000 * 1024);
		expect(result.cpu).toBeCloseTo(3.0, 1);
	});
});

describe("resource-monitor poller", () => {
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
		expect(getResourceUsage("task-12345678-abcd")).toBeUndefined();
	});

	it("polls and pushes resource usage after interval", async () => {
		// Mock tmux list-sessions to return one session
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-abc12345")) // discoverTmuxSessions
			.mockReturnValue(makeResult("100   204800   5.2\n200   102400   2.1")); // ps

		mockCollectTaskPids.mockReturnValue(new Set([100, 200]));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("resourceUsageUpdated", {
			taskId: "abc12345",
			usage: expect.objectContaining({
				cpu: expect.any(Number),
				rss: expect.any(Number),
			}),
		});

		// getResourceUsage uses shortId internally
		const usage = getResourceUsage("abc12345-full-task-id");
		expect(usage).toBeDefined();
		expect(usage!.rss).toBe(307200 * 1024);
		expect(usage!.cpu).toBeCloseTo(7.3, 1);
	});

	it("skips session with no PIDs", async () => {
		mockSpawnSync.mockReturnValueOnce(makeResult("dev3-nopids00"));
		mockCollectTaskPids.mockReturnValue(new Set());

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).not.toHaveBeenCalled();
	});

	it("cleans up stale cache for sessions no longer active", async () => {
		// First poll: session exists
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-gone0000")) // discover
			.mockReturnValue(makeResult("100   102400   5.0")); // ps
		mockCollectTaskPids.mockReturnValue(new Set([100]));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("gone0000-full-id")).toBeDefined();

		// Second poll: session gone
		mockSpawnSync.mockReturnValue(makeResult("")); // empty session list
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("gone0000-full-id")).toBeUndefined();
	});
});
