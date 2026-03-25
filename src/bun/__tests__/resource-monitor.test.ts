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

vi.mock("../caffeinate", () => ({
	updateCaffeinateState: vi.fn(),
}));

// Partial mock: stub only getSessionPanePids; let collectProcessInfo and
// collectDescendants run through their real implementations (which go through
// the already-mocked spawnSync above).
vi.mock("../port-scanner", async (importActual) => {
	const actual = await importActual<typeof import("../port-scanner")>();
	return {
		...actual,
		getSessionPanePids: vi.fn(),
	};
});

import { startResourceMonitor, stopResourceMonitor, getResourceUsage, aggregateResources } from "../resource-monitor";
import { spawnSync } from "../spawn";
import { getSessionPanePids, clearProcessInfoCache } from "../port-scanner";

const mockSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;
const mockGetSessionPanePids = getSessionPanePids as unknown as ReturnType<typeof vi.fn>;

function makeResult(stdout: string, exitCode = 0) {
	return {
		stdout: new TextEncoder().encode(stdout),
		stderr: new Uint8Array(),
		exitCode,
	};
}

describe("aggregateResources", () => {
	it("sums RSS and CPU for given PIDs", () => {
		const resources = new Map([
			[100, { rss: 204800 * 1024, cpu: 5.2 }],
			[200, { rss: 102400 * 1024, cpu: 2.1 }],
			[300, { rss: 51200 * 1024, cpu: 0.5 }],
		]);

		const result = aggregateResources(new Set([100, 200, 300]), resources);
		expect(result.rss).toBe(358400 * 1024);
		expect(result.cpu).toBeCloseTo(7.8, 1);
	});

	it("returns zeros for empty PID set", () => {
		const resources = new Map([[100, { rss: 1024, cpu: 5.0 }]]);
		const result = aggregateResources(new Set(), resources);
		expect(result).toEqual({ rss: 0, cpu: 0 });
	});

	it("ignores PIDs not in resources map", () => {
		const resources = new Map([[100, { rss: 1024, cpu: 5.0 }]]);
		const result = aggregateResources(new Set([100, 999]), resources);
		expect(result.rss).toBe(1024);
		expect(result.cpu).toBe(5.0);
	});
});

describe("resource-monitor poller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawnSync.mockReset();
		mockGetSessionPanePids.mockReset();
		clearProcessInfoCache();
	});

	afterEach(() => {
		stopResourceMonitor();
		vi.useRealTimers();
	});

	it("getResourceUsage returns undefined when no data collected", () => {
		expect(getResourceUsage("task-12345678-abcd")).toBeUndefined();
	});

	it("polls and pushes resource usage after interval", async () => {
		// Mock tmux list-sessions → one session
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-abc12345")) // discoverTmuxSessions
			.mockReturnValueOnce(makeResult(
				"  100     1   204800   5.2\n  200   100   102400   2.1\n",
			)); // collectProcessInfo (single ps call)

		// Mock tmux list-panes
		mockGetSessionPanePids
			.mockReturnValueOnce([100]) // main session
			.mockReturnValueOnce([]); // dev session

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

		// PID 100 (rss: 204800KB) + PID 200 (rss: 102400KB) = 307200KB
		const usage = getResourceUsage("abc12345-full-task-id");
		expect(usage).toBeDefined();
		expect(usage!.rss).toBe(307200 * 1024);
		expect(usage!.cpu).toBeCloseTo(7.3, 1);
	});

	it("skips session with no PIDs", async () => {
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-nopids00")) // discoverTmuxSessions
			.mockReturnValueOnce(makeResult("  1     0   1000   0.1\n")); // collectProcessInfo

		mockGetSessionPanePids
			.mockReturnValueOnce([]) // main session — no panes
			.mockReturnValueOnce([]); // dev session

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).not.toHaveBeenCalled();
	});

	it("cleans up stale cache and pushes zero usage", async () => {
		// First poll: session exists
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-gone0000")) // discover
			.mockReturnValueOnce(makeResult("  100     1   102400   5.0\n")); // ps

		mockGetSessionPanePids
			.mockReturnValueOnce([100]) // main
			.mockReturnValueOnce([]); // dev

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("gone0000-full-id")).toBeDefined();

		// Second poll: session gone — push zero usage
		mockSpawnSync.mockReturnValueOnce(makeResult("")); // empty session list
		await vi.advanceTimersByTimeAsync(10_000);

		expect(getResourceUsage("gone0000-full-id")).toBeUndefined();

		// Verify zero-usage push was sent
		const lastCall = push.mock.calls[push.mock.calls.length - 1];
		expect(lastCall[0]).toBe("resourceUsageUpdated");
		expect(lastCall[1]).toEqual({
			taskId: "gone0000",
			usage: { cpu: 0, rss: 0 },
		});
	});

	it("pushes again when CPU change exceeds tolerance", async () => {
		// First poll
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-cpujump0")) // discover
			.mockReturnValueOnce(makeResult("  100     1   102400   5.0\n")); // ps

		mockGetSessionPanePids
			.mockReturnValueOnce([100])
			.mockReturnValueOnce([]);

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll: CPU jumps by >1%
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-cpujump0"))
			.mockReturnValueOnce(makeResult("  100     1   102400   50.0\n"));

		mockGetSessionPanePids
			.mockReturnValueOnce([100])
			.mockReturnValueOnce([]);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("only uses 2 spawnSync calls per poll cycle (tmux + ps)", async () => {
		mockSpawnSync
			.mockReturnValueOnce(makeResult("dev3-aaa00000\ndev3-bbb00000")) // discover (1 call)
			.mockReturnValueOnce(makeResult( // collectProcessInfo (1 call)
				"  100     1   50000   1.0\n  200     1   60000   2.0\n",
			));

		mockGetSessionPanePids
			.mockReturnValueOnce([100]) // aaa main
			.mockReturnValueOnce([]) // aaa dev
			.mockReturnValueOnce([200]) // bbb main
			.mockReturnValueOnce([]); // bbb dev

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		// Only 2 spawnSync calls: tmux list-sessions + ps -eo
		// (getSessionPanePids is mocked separately from port-scanner)
		expect(mockSpawnSync).toHaveBeenCalledTimes(2);
		expect(push).toHaveBeenCalledTimes(2);
	});
});
