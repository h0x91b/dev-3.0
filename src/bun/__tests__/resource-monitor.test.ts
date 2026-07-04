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

// Partial mock: stub only getAllSessionPanePids; let collectProcessInfo and
// collectDescendants run through their real implementations (which go through
// the already-mocked spawn above).
vi.mock("../port-scanner", async (importActual) => {
	const actual = await importActual<typeof import("../port-scanner")>();
	return {
		...actual,
		getAllSessionPanePids: vi.fn(),
	};
});

import { startResourceMonitor, stopResourceMonitor, getResourceUsage, aggregateResources } from "../resource-monitor";
import { spawn } from "../spawn";
import { getAllSessionPanePids, clearProcessInfoCache } from "../port-scanner";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockGetAllSessionPanePids = getAllSessionPanePids as unknown as ReturnType<typeof vi.fn>;

// Async spawn stub: `new Response(proc.stdout).text()` accepts a plain string.
function makeProc(stdout: string, exitCode = 0) {
	return {
		stdout,
		stderr: "",
		exitCode,
		exited: Promise.resolve(exitCode),
	};
}

function paneMap(entries: Record<string, number[]>): Map<string, number[]> {
	return new Map(Object.entries(entries));
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
		mockSpawn.mockReset();
		mockGetAllSessionPanePids.mockReset();
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
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-abc12345": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc(
			"  100     1   204800   5.2\n  200   100   102400   2.1\n",
		)); // collectProcessInfo (single ps call)

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
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-nopids00": [] }));
		mockSpawn.mockReturnValueOnce(makeProc("  1     0   1000   0.1\n")); // collectProcessInfo

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).not.toHaveBeenCalled();
	});

	it("excludes cleanup, dev-server, and project-terminal sessions", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({
			"dev3-cl-abc12345": [10],
			"dev3-dev-abc12345": [20],
			"dev3-pt-abc12345": [30],
			"other-session": [40],
		}));
		mockSpawn.mockReturnValueOnce(makeProc("  10     1   1000   0.1\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).not.toHaveBeenCalled();
	});

	it("cleans up stale cache and pushes zero usage", async () => {
		// First poll: session exists
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-gone0000": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   102400   5.0\n")); // ps

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getResourceUsage("gone0000-full-id")).toBeDefined();

		// Second poll: session gone — push zero usage
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
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
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-cpujump0": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   102400   5.0\n")); // ps

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll: CPU jumps by >1%
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-cpujump0": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   102400   50.0\n"));

		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(2);
	});

	it("includes dev-server session pane PIDs in the task's usage", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({
			"dev3-devtask0": [100],
			"dev3-dev-devtask0": [500],
		}));
		mockSpawn.mockReturnValueOnce(makeProc(
			"  100     1   100000   1.0\n  500     1   200000   2.0\n",
		));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		const usage = getResourceUsage("devtask0-full-id");
		expect(usage).toBeDefined();
		expect(usage!.rss).toBe(300000 * 1024);
	});

	it("only spawns once per poll cycle (single ps; tmux is batched)", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({
			"dev3-aaa00000": [100],
			"dev3-bbb00000": [200],
		}));
		mockSpawn.mockReturnValueOnce(makeProc( // collectProcessInfo (1 call)
			"  100     1   50000   1.0\n  200     1   60000   2.0\n",
		));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		// Single ps spawn; pane PIDs come from the (mocked) batched tmux call.
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(mockGetAllSessionPanePids).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(2);
	});
});
