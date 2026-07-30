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

// The poller must not know which platform it is on — the probe is the seam, and
// platform parsing is covered directly in system-memory.test.ts.
vi.mock("../system-memory-probe", () => ({
	probeMemoryFacts: vi.fn(),
}));

// Task titles for the breakdown come from the data layer; keep the poller tests
// off the filesystem.
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
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

import { startResourceMonitor, stopResourceMonitor, getResourceUsage, aggregateResources, getSystemMemorySnapshot } from "../resource-monitor";
import { spawn } from "../spawn";
import { getAllSessionPanePids, clearProcessInfoCache } from "../port-scanner";
import { probeMemoryFacts } from "../system-memory-probe";
import { loadProjects, loadTasks } from "../data";
import type { MemoryFacts } from "../system-memory";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockGetAllSessionPanePids = getAllSessionPanePids as unknown as ReturnType<typeof vi.fn>;
const mockProbe = probeMemoryFacts as unknown as ReturnType<typeof vi.fn>;
const mockLoadProjects = loadProjects as unknown as ReturnType<typeof vi.fn>;
const mockLoadTasks = loadTasks as unknown as ReturnType<typeof vi.fn>;

const GIB = 1024 ** 3;

function makeFacts(overrides?: Partial<MemoryFacts>): MemoryFacts {
	return {
		total: 64 * GIB,
		used: 32 * GIB,
		headroom: 32 * GIB,
		cached: 8 * GIB,
		swapTotal: 2 * GIB,
		swapUsed: 0,
		swapOutCount: 100,
		osPressure: "normal",
		...overrides,
	};
}

/** Pull the payloads of every systemMemoryUpdated push. */
function memoryPushes(push: ReturnType<typeof vi.fn>) {
	return push.mock.calls.filter((c) => c[0] === "systemMemoryUpdated").map((c) => c[1]);
}

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
		mockProbe.mockReset();
		// Default: no platform snapshot, so the existing per-task expectations
		// below are unaffected by the memory widget's tick.
		mockProbe.mockResolvedValue(null);
		mockLoadProjects.mockResolvedValue([]);
		mockLoadTasks.mockResolvedValue([]);
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

describe("system memory snapshot", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
		mockGetAllSessionPanePids.mockReset();
		mockProbe.mockReset();
		mockProbe.mockResolvedValue(makeFacts());
		mockLoadProjects.mockResolvedValue([]);
		mockLoadTasks.mockResolvedValue([]);
		clearProcessInfoCache();
	});

	afterEach(() => {
		stopResourceMonitor();
		vi.useRealTimers();
	});

	it("is taken in the same tick as the per-task figures", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-abc12345": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   204800   5.2 /usr/bin/node agent.js\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		const snapshots = memoryPushes(push);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({
			headroom: 32 * GIB,
			total: 64 * GIB,
			pressure: "normal",
			activeTaskCount: 1,
		});
	});

	it("is taken with zero active tasks, so an empty board still shows memory", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   204800   5.2 /usr/bin/node other.js\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		const snapshots = memoryPushes(push);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ activeTaskCount: 0, tasksRssApprox: 0, medianTaskRss: null });
	});

	it("exposes the snapshot to the RPC getter", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));

		expect(getSystemMemorySnapshot()).toBeNull();
		startResourceMonitor(vi.fn());
		await vi.advanceTimersByTimeAsync(10_000);

		expect(getSystemMemorySnapshot()).toMatchObject({ total: 64 * GIB });
	});

	it("keeps the task subtotal as a sum of task tree RSS", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-aaa00000": [100], "dev3-bbb00000": [200] }));
		mockSpawn.mockReturnValueOnce(makeProc(
			"  100     1   1048576   1.0 /usr/bin/node a.js\n  200     1   2097152   2.0 /usr/bin/node b.js\n",
		));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		const snapshot = memoryPushes(push)[0];
		// 1048576 KB + 2097152 KB, and the median of the two task figures.
		expect(snapshot.tasksRssApprox).toBe((1048576 + 2097152) * 1024);
		expect(snapshot.medianTaskRss).toBe(Math.round((1048576 + 2097152) * 1024 / 2));
	});

	it("excludes task processes from the system-wide consumer list", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-abc12345": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc(
			"  100     1   900000   1.0 /usr/bin/node agent-of-a-task.js\n" +
			"  700     1   500000   1.0 /usr/local/bin/dockerd --host=fd://\n",
		));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		const names = memoryPushes(push)[0].topConsumers.map((c: { name: string }) => c.name);
		expect(names).toContain("Docker");
		expect(names).not.toContain("node");
	});

	it("resolves heavy task titles and their project for the clickable rows", async () => {
		mockLoadProjects.mockResolvedValue([{ id: "p1", name: "Proj", path: "/tmp/p1" }]);
		mockLoadTasks.mockResolvedValue([{ id: "abc12345-dead-beef", title: "Fix the parser" }]);
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-abc12345": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   204800   5.2 /usr/bin/node agent.js\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(memoryPushes(push)[0].topTasks).toEqual([
			{ shortId: "abc12345", taskId: "abc12345-dead-beef", title: "Fix the parser", projectId: "p1", rss: 204800 * 1024 },
		]);
	});

	it("still reports a heavy task whose title cannot be resolved", async () => {
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-orphan00": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   204800   5.2 /usr/bin/node agent.js\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(memoryPushes(push)[0].topTasks).toEqual([
			{ shortId: "orphan00", taskId: null, title: "", projectId: "", rss: 204800 * 1024 },
		]);
	});

	it("suppresses a push when nothing meaningful moved", async () => {
		const push = vi.fn();
		startResourceMonitor(push);

		for (let i = 0; i < 2; i++) {
			mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
			mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
			clearProcessInfoCache();
			await vi.advanceTimersByTimeAsync(10_000);
		}

		expect(memoryPushes(push)).toHaveLength(1);
	});

	it("pushes when the pressure level changes", async () => {
		const push = vi.fn();
		startResourceMonitor(push);

		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		await vi.advanceTimersByTimeAsync(10_000);

		mockProbe.mockResolvedValue(makeFacts({ osPressure: "critical" }));
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		clearProcessInfoCache();
		await vi.advanceTimersByTimeAsync(10_000);

		const snapshots = memoryPushes(push);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[1].pressure).toBe("critical");
	});

	it("pushes when the machine starts swapping, and escalates the pressure", async () => {
		const push = vi.fn();
		startResourceMonitor(push);

		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(memoryPushes(push)[0].swapping).toBe(false);

		// Same OS verdict, but the swap-out counter moved.
		mockProbe.mockResolvedValue(makeFacts({ swapOutCount: 500, osPressure: "normal" }));
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		clearProcessInfoCache();
		await vi.advanceTimersByTimeAsync(10_000);

		const latest = memoryPushes(push)[1];
		expect(latest.swapping).toBe(true);
		expect(latest.pressure).toBe("warn");
	});

	it("pushes when headroom moves past the threshold", async () => {
		const push = vi.fn();
		startResourceMonitor(push);

		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		await vi.advanceTimersByTimeAsync(10_000);

		mockProbe.mockResolvedValue(makeFacts({ headroom: 4 * GIB, used: 60 * GIB }));
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({}));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   1000   0.1 /usr/bin/node x.js\n"));
		clearProcessInfoCache();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(memoryPushes(push)).toHaveLength(2);
	});

	it("a failing probe costs the snapshot, not the per-task push", async () => {
		mockProbe.mockRejectedValue(new Error("vm_stat exploded"));
		mockGetAllSessionPanePids.mockResolvedValueOnce(paneMap({ "dev3-abc12345": [100] }));
		mockSpawn.mockReturnValueOnce(makeProc("  100     1   204800   5.2 /usr/bin/node agent.js\n"));

		const push = vi.fn();
		startResourceMonitor(push);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(memoryPushes(push)).toHaveLength(0);
		expect(push).toHaveBeenCalledWith("resourceUsageUpdated", expect.anything());
		expect(getSystemMemorySnapshot()).toBeNull();
	});
});
