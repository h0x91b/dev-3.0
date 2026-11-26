import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawn/spawnSync before importing port-scanner
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// Mock logger
vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}));

vi.mock("../port-tunnels", () => ({ cleanupTaskTunnels: vi.fn() }));

import { cleanupTaskTunnels } from "../port-tunnels";
import {
	nativeTaskPaneRoots,
	setNativePaneRecordsReader,
	parseLsofOutput,
	getDescendantPids,
	getSessionPanePids,
	getAllSessionPanePids,
	scanTaskPorts,
	getLsofOutput,
	collectTaskPids,
	buildProcessTree,
	collectDescendants,
	collectProcessInfo,
	parseProcessInfoOutput,
	clearProcessInfoCache,
	startPortScanPoller,
	stopPortScanPoller,
	getPortsForTask,
	parsePortHolders,
	findPortHolders,
	waitForPortsFree,
} from "../port-scanner";
import { spawn } from "../spawn";
import { clearDevServerStart, recordDevServerStart } from "../dev-server-ports";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

// Async spawn stub: `new Response(proc.stdout).text()` accepts a plain string.
function makeProc(stdout: string, exitCode = 0) {
	return {
		stdout,
		stderr: "",
		exitCode,
		exited: Promise.resolve(exitCode),
	};
}

describe("parseLsofOutput", () => {
	it("parses valid lsof -F output, keeping only PIDs in the set", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"p456",
			"cbun",
			"n127.0.0.1:8080",
			"p999",
			"cpython3",
			"n*:5000",
		].join("\n");

		const result = parseLsofOutput(output, new Set([123, 456]));

		expect(result).toEqual([
			{ port: 3000, pid: 123, processName: "node" },
			{ port: 8080, pid: 456, processName: "bun" },
		]);
		expect(parseLsofOutput("", new Set())).toEqual([]);
	});

	it("skips malformed lines, deduplicates and sorts ports numerically", () => {
		const output = [
			"p123",
			"cnode",
			"ngarbage-no-port",
			"n*:8080",
			"n*:3000",
			"n127.0.0.1:3000",
			"n*:5173",
		].join("\n");

		const result = parseLsofOutput(output, new Set([123]));
		expect(result.map((p) => p.port)).toEqual([3000, 5173, 8080]);
	});

	it("accepts ports 1..65535 only", () => {
		const parse = (port: number) => parseLsofOutput(`p123\ncnode\nn*:${port}\n`, new Set([123]));
		expect(parse(0)).toEqual([]);
		expect(parse(70000)).toEqual([]);
		expect(parse(65535).map((p) => p.port)).toEqual([65535]);
	});
});

describe("parsePortHolders", () => {
	it("returns holders of the requested ports regardless of owner pid", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"n*:5173",
			"p456",
			"cbun",
			"n127.0.0.1:8080",
		].join("\n");

		const result = parsePortHolders(output, new Set([3000, 8080]));
		expect(result).toEqual([
			{ port: 3000, pid: 123, processName: "node" },
			{ port: 8080, pid: 456, processName: "bun" },
		]);
	});

	it("deduplicates a port bound on multiple interfaces and skips malformed lines", () => {
		const output = "p123\ncnode\nngarbage-no-port\nn*:3000\nn127.0.0.1:3000\n";
		const result = parsePortHolders(output, new Set([3000]));
		expect(result).toEqual([{ port: 3000, pid: 123, processName: "node" }]);
	});
});

describe("parseProcessInfoOutput", () => {
	it("parses ps output into tree and resources, skipping malformed lines", () => {
		const { tree, resources } = parseProcessInfoOutput(
			"garbage\n  100     1   204800   5.2\n  200   100   102400   2.1\n  300   200    51200   0.5\n",
		);

		expect(tree.get(1)).toEqual([100]);
		expect(tree.get(100)).toEqual([200]);
		expect(tree.get(200)).toEqual([300]);
		expect(tree.size).toBe(3);

		expect(resources.get(100)).toEqual({ rss: 204800 * 1024, cpu: 5.2 });
		expect(resources.get(200)).toEqual({ rss: 102400 * 1024, cpu: 2.1 });
		expect(resources.get(300)).toEqual({ rss: 51200 * 1024, cpu: 0.5 });
	});
});

describe("getAllSessionPanePids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("groups pane PIDs by session name from one tmux list-panes -a call", async () => {
		mockSpawn.mockReturnValue(makeProc([
			"100\tdev3-abc12345",
			"101\tdev3-abc12345",
			"500\tdev3-dev-abc12345",
			"200\tdev3-other000",
		].join("\n") + "\n"));

		const map = await getAllSessionPanePids("dev3");
		expect(map.get("dev3-abc12345")).toEqual([100, 101]);
		expect(map.get("dev3-dev-abc12345")).toEqual([500]);
		expect(map.get("dev3-other000")).toEqual([200]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const [argv] = mockSpawn.mock.calls[0];
		expect(argv).toContain("list-panes");
		expect(argv).toContain("-a");
	});

	it("skips malformed lines and returns an empty map when tmux fails", async () => {
		mockSpawn.mockReturnValue(makeProc("no-tab-here\n42\tdev3-ok000000\n\t\nNaN\tdev3-bad00000\n"));
		const map = await getAllSessionPanePids("dev3");
		expect([...map.keys()]).toEqual(["dev3-ok000000"]);
		expect(map.get("dev3-ok000000")).toEqual([42]);

		mockSpawn.mockReturnValue(makeProc("", 1));
		expect((await getAllSessionPanePids("dev3")).size).toBe(0);
	});
});

describe("findPortHolders", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("never spawns lsof for an empty port list or when output is provided", async () => {
		expect(await findPortHolders([])).toEqual([]);
		const result = await findPortHolders([3000], "p123\ncnode\nn*:3000\n");
		expect(result).toEqual([{ port: 3000, pid: 123, processName: "node" }]);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("spawns lsof when no output is provided", async () => {
		mockSpawn.mockReturnValue(makeProc("p9\ncbun\nn*:4000\n"));
		const result = await findPortHolders([4000]);
		expect(result).toEqual([{ port: 4000, pid: 9, processName: "bun" }]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});

describe("waitForPortsFree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns immediately for an empty port list or ports that are already free", async () => {
		expect(await waitForPortsFree([], 5000, 10)).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();

		mockSpawn.mockReturnValue(makeProc(""));
		expect(await waitForPortsFree([3000], 5000, 10)).toEqual([]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	it("polls until the holder releases the port", async () => {
		mockSpawn
			.mockReturnValueOnce(makeProc("p123\ncnode\nn*:3000\n"))
			.mockReturnValueOnce(makeProc("p123\ncnode\nn*:3000\n"))
			.mockReturnValue(makeProc(""));
		const holders = await waitForPortsFree([3000], 5000, 10);
		expect(holders).toEqual([]);
		expect(mockSpawn).toHaveBeenCalledTimes(3);
	});

	it("returns the surviving holders when the timeout elapses", async () => {
		mockSpawn.mockReturnValue(makeProc("p123\ncnode\nn*:3000\n"));
		const holders = await waitForPortsFree([3000], 30, 10);
		expect(holders).toEqual([{ port: 3000, pid: 123, processName: "node" }]);
	});
});

describe("getDescendantPids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	// getDescendantPids walks a single `ps` snapshot (NOT `pgrep -P`, which
	// returns nothing when spawned from the packaged GUI .app — see decision
	// 095). The mocks below provide that one ps table.

	it("returns sibling children, and nothing for a leaf", async () => {
		mockSpawn.mockReturnValue(makeProc("100 1 0 0.0\n200 100 0 0.0\n201 100 0 0.0\n"));
		expect(await getDescendantPids(100)).toEqual([200, 201]);
		expect(await getDescendantPids(201)).toEqual([]);
	});

	it("collects a deep dev-server tree via ONE ps call, not pgrep (decision 095)", async () => {
		// Mirrors the real orphaned tree: bash → bun → electrobun → launcher →
		// app-bun → caffeinate, where the app subtree is in a different process
		// group. A `ps` walk must still capture every descendant.
		mockSpawn.mockReturnValue(
			makeProc(
				[
					"10 1 0 0.0", // pane: bash dev.sh
					"20 10 0 0.0", // bun run dev
					"30 20 0 0.0", // bash -c
					"40 30 0 0.0", // node electrobun
					"50 40 0 0.0", // electrobun bun (new process group)
					"60 50 0 0.0", // launcher
					"70 60 0 0.0", // app bun (main.js)
					"80 70 0 0.0", // caffeinate
				].join("\n") + "\n",
			),
		);

		const result = await getDescendantPids(10);
		expect(result).toEqual([20, 30, 40, 50, 60, 70, 80]);
		// Exactly one spawn — the ps snapshot. No per-PID pgrep fan-out.
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const [argv] = mockSpawn.mock.calls[0];
		expect(argv[0]).toBe("ps");
		expect(argv).not.toContain("pgrep");
	});
});

describe("getSessionPanePids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns pane PIDs from tmux output, and empty on tmux failure", async () => {
		mockSpawn.mockReturnValue(makeProc("12345\n67890\n"));
		expect(await getSessionPanePids("dev3", "dev3-abc12345")).toEqual([12345, 67890]);

		mockSpawn.mockReturnValue(makeProc("", 1));
		expect(await getSessionPanePids("dev3", "dev3-abc12345")).toEqual([]);
	});
});

describe("getLsofOutput", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns lsof stdout on success", async () => {
		mockSpawn.mockReturnValue(makeProc("p123\ncnode\nn*:3000\n"));
		const result = await getLsofOutput();
		expect(result).toBe("p123\ncnode\nn*:3000\n");
	});

	it("returns empty string on failure or exception", async () => {
		mockSpawn.mockReturnValue(makeProc("", 1));
		expect(await getLsofOutput()).toBe("");
		mockSpawn.mockImplementation(() => { throw new Error("boom"); });
		expect(await getLsofOutput()).toBe("");
	});
});

describe("collectProcessInfo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	it("returns empty maps on ps failure", async () => {
		mockSpawn.mockReturnValueOnce(makeProc("", 1));
		const { tree, resources } = await collectProcessInfo();
		expect(tree.size).toBe(0);
		expect(resources.size).toBe(0);
	});

	it("serves cached result on second call within TTL", async () => {
		mockSpawn.mockReturnValueOnce(
			makeProc("  100     1   50000   1.0\n"),
		);

		const first = await collectProcessInfo();
		const second = await collectProcessInfo();

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(second).toBe(first); // same reference
	});

	it("shares one spawn between concurrent callers", async () => {
		mockSpawn.mockReturnValueOnce(
			makeProc("  100     1   50000   1.0\n"),
		);

		const [first, second] = await Promise.all([collectProcessInfo(), collectProcessInfo()]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});
});

describe("buildProcessTree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	it("builds parent→children map from ps output", async () => {
		mockSpawn.mockReturnValueOnce(
			makeProc("  100     1   0   0.0\n  200   100   0   0.0\n  300   100   0   0.0\n  400   200   0   0.0\n"),
		);

		const tree = await buildProcessTree();
		expect(tree.get(1)).toEqual([100]);
		expect(tree.get(100)).toEqual([200, 300]);
		expect(tree.get(200)).toEqual([400]);
	});

	it("returns empty map on ps failure or exception", async () => {
		mockSpawn.mockReturnValueOnce(makeProc("", 1));
		expect((await buildProcessTree()).size).toBe(0);
		clearProcessInfoCache();
		mockSpawn.mockImplementation(() => { throw new Error("boom"); });
		expect((await buildProcessTree()).size).toBe(0);
	});
});

describe("collectDescendants", () => {
	it("returns all descendants via in-memory BFS, empty for a leaf or unknown PID", () => {
		const tree = new Map<number, number[]>([
			[1, [100]],
			[100, [200, 300]],
			[200, [400]],
		]);

		expect(collectDescendants(100, tree)).toEqual([200, 300, 400]);
		expect(collectDescendants(400, tree)).toEqual([]);
		expect(collectDescendants(999, tree)).toEqual([]);
	});
});

// Route spawn calls by argv — order-independent and robust to internal
// call-order changes.
function routeSpawnByArgv(routes: {
	ps?: string | { stdout: string; exitCode: number };
	lsof?: string | { stdout: string; exitCode: number };
	panes?: Record<string, string | { stdout: string; exitCode: number }>;
	allPanes?: string | { stdout: string; exitCode: number };
}) {
	mockSpawn.mockImplementation((cmd: string[]) => {
		const toProc = (r: string | { stdout: string; exitCode: number } | undefined) => {
			if (r === undefined) return makeProc("", 1);
			return typeof r === "string" ? makeProc(r) : makeProc(r.stdout, r.exitCode);
		};
		if (cmd[0] === "ps") return toProc(routes.ps);
		if (cmd[0] === "lsof") return toProc(routes.lsof);
		if (cmd.includes("list-panes") && cmd.includes("-a")) return toProc(routes.allPanes);
		if (cmd.includes("list-panes")) {
			const target = cmd[cmd.indexOf("-t") + 1];
			return toProc(routes.panes?.[target]);
		}
		return makeProc("", 1);
	});
}

describe("collectTaskPids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	it("returns pane PIDs plus descendants", async () => {
		routeSpawnByArgv({
			ps: "100 1 0 0.0\n200 100 0 0.0\n",
			panes: { "dev3-abc12345": "100\n" },
		});

		const pids = await collectTaskPids("dev3", "dev3-abc12345");
		expect(pids).toEqual(new Set([100, 200]));
	});

	it("returns empty set when no pane PIDs", async () => {
		routeSpawnByArgv({ ps: "" });
		const pids = await collectTaskPids("dev3", "dev3-abc12345");
		expect(pids.size).toBe(0);
	});

	it("includes PIDs from dev server session (dev3-dev-*)", async () => {
		routeSpawnByArgv({
			ps: "100 1 0 0.0\n200 100 0 0.0\n500 1 0 0.0\n600 500 0 0.0\n",
			panes: {
				"dev3-abc12345": "100\n",
				"dev3-dev-abc12345": "500\n",
			},
		});

		const pids = await collectTaskPids("dev3", "dev3-abc12345");
		expect(pids).toEqual(new Set([100, 200, 500, 600]));

		// Verify tmux was called for both sessions
		expect(mockSpawn).toHaveBeenCalledWith(
			expect.arrayContaining(["list-panes", "-t", "dev3-abc12345"]),
			expect.anything(),
		);
		expect(mockSpawn).toHaveBeenCalledWith(
			expect.arrayContaining(["list-panes", "-t", "dev3-dev-abc12345"]),
			expect.anything(),
		);
	});

	it("does not recurse for dev3-dev-* session names", async () => {
		routeSpawnByArgv({
			ps: "500 1 0 0.0\n",
			panes: { "dev3-dev-abc12345": "500\n" },
		});

		const pids = await collectTaskPids("dev3", "dev3-dev-abc12345");
		expect(pids).toEqual(new Set([500]));

		// Should NOT have called list-panes for dev3-dev-dev-abc12345
		const listPaneCalls = mockSpawn.mock.calls.filter(
			(args: any) => args[0]?.includes?.("list-panes"),
		);
		expect(listPaneCalls).toHaveLength(1);
	});

	it("uses processTree when provided (no ps spawn)", async () => {
		const tree = new Map<number, number[]>([
			[1, [100]],
			[100, [200, 300]],
		]);

		routeSpawnByArgv({
			panes: { "dev3-abc12345": "100\n" },
		});

		const pids = await collectTaskPids("dev3", "dev3-abc12345", tree);
		expect(pids).toEqual(new Set([100, 200, 300]));

		// Only tmux calls (main + dev session), no ps
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it("uses paneMap when provided (no tmux spawns at all)", async () => {
		const tree = new Map<number, number[]>([[100, [200]]]);
		const paneMap = new Map<string, number[]>([
			["dev3-abc12345", [100]],
			["dev3-dev-abc12345", [500]],
		]);

		const pids = await collectTaskPids("dev3", "dev3-abc12345", tree, paneMap);
		expect(pids).toEqual(new Set([100, 200, 500]));
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("scanTaskPorts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	it("orchestrates pane PIDs, descendants, and lsof parsing; empty without panes", async () => {
		routeSpawnByArgv({});
		expect(await scanTaskPorts("dev3", "dev3-abc12345")).toEqual([]);

		clearProcessInfoCache();
		routeSpawnByArgv({
			ps: "100 1 0 0.0\n200 100 0 0.0\n",
			lsof: "p200\ncnode\nn*:3000\n",
			panes: { "dev3-abc12345": "100\n" },
		});

		const result = await scanTaskPorts("dev3", "dev3-abc12345");
		expect(result).toEqual([
			{ port: 3000, pid: 200, processName: "node" },
		]);
	});

	it("uses pre-fetched lsof output when provided", async () => {
		routeSpawnByArgv({
			ps: "100 1 0 0.0\n",
			panes: { "dev3-abc12345": "100\n" },
		});

		const lsofOutput = "p100\ncbun\nn*:8080\n";
		const result = await scanTaskPorts("dev3", "dev3-abc12345", lsofOutput);
		expect(result).toEqual([
			{ port: 8080, pid: 100, processName: "bun" },
		]);
		// No lsof spawn — verify no call had lsof as argv[0]
		const lsofCalls = mockSpawn.mock.calls.filter((args: any) => args[0]?.[0] === "lsof");
		expect(lsofCalls).toHaveLength(0);
	});
});

describe("poller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		clearProcessInfoCache();
		stopPortScanPoller();
	});

	afterEach(() => {
		stopPortScanPoller();
		vi.useRealTimers();
	});

	it("pushes portsUpdated when ports change, and not again when unchanged", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-1234-5678-abcd", tmuxSocket: "dev3" },
		]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\n",
			allPanes: "100\tdev3-task-123\n",
		});

		startPortScanPoller(push, getActiveSessions);

		// Advance past first poll interval (async poll body)
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId: "task-1234-5678-abcd",
			ports: [{ port: 3000, pid: 100, processName: "node" }],
		});
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll cycle — same ports, no second push
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("issues one ps + one lsof + one tmux list-panes -a per cycle", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-aaaa-1111", tmuxSocket: "dev3" },
			{ taskId: "task-bbbb-2222", tmuxSocket: "dev3" },
			{ taskId: "task-cccc-3333", tmuxSocket: "dev3" },
		]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\n",
			allPanes: "100\tdev3-task-aaa\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		// Batched: 3 spawns total for 3 sessions — NOT 2 per session.
		expect(mockSpawn).toHaveBeenCalledTimes(3);
		const argv0s = mockSpawn.mock.calls.map((args: any) => args[0][0]).sort();
		expect(argv0s).toEqual(["lsof", "ps", "tmux"]);
	});

	it("cleans up stale cache entries when sessions disappear", async () => {
		const push = vi.fn();
		let sessions = [
			{ taskId: "task-aaaa", tmuxSocket: "dev3" },
			{ taskId: "task-bbbb", tmuxSocket: "dev3" },
		];
		const getActiveSessions = vi.fn().mockImplementation(() => sessions);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n  200     1   60000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\np200\ncbun\nn*:8080\n",
			allPanes: "100\tdev3-task-aaa\n200\tdev3-task-bbb\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(2);
		expect(getPortsForTask("task-aaaa")).toHaveLength(1);
		expect(getPortsForTask("task-bbbb")).toHaveLength(1);

		// Second poll: task-bbbb is gone
		sessions = [{ taskId: "task-aaaa", tmuxSocket: "dev3" }];
		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\n",
			allPanes: "100\tdev3-task-aaa\n",
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(getPortsForTask("task-bbbb")).toEqual([]);
	});

	it("continues polling even if getActiveSessions throws", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn()
			.mockImplementationOnce(() => { throw new Error("boom"); })
			.mockReturnValue([]);

		startPortScanPoller(push, getActiveSessions);

		// First poll — throws
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).not.toHaveBeenCalled();

		// Second poll — should still fire (poller survived)
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getActiveSessions).toHaveBeenCalledTimes(2);
	});

	// A containerised devScript never owns its published socket (the container
	// runtime's daemon does), so ownership alone reported no ports at all for
	// such a task — the UI badge stayed empty (issue #1427).
	it("includes an assigned port published for the task's dev server", async () => {
		const taskId = "task-published-1";
		recordDevServerStart(taskId, "dev", [10569], []);
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([{ taskId, tmuxSocket: "dev3" }]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\np1380\nccom.docker.backend\nn*:10569\n",
			allPanes: "100\tdev3-task-pub\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId,
			ports: [
				{ port: 3000, pid: 100, processName: "node" },
				{ port: 10569, pid: 1380, processName: "com.docker.backend" },
			],
		});
		clearDevServerStart(taskId, "dev");
	});

	it("ignores a foreign holder that was already listening before the dev server started", async () => {
		const taskId = "task-squatted-1";
		recordDevServerStart(taskId, "dev", [10569], [{ port: 10569, pid: 1380, processName: "com.docker.backend" }]);
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([{ taskId, tmuxSocket: "dev3" }]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\np1380\nccom.docker.backend\nn*:10569\n",
			allPanes: "100\tdev3-task-squ\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId,
			ports: [{ port: 3000, pid: 100, processName: "node" }],
		});
		clearDevServerStart(taskId, "dev");
	});

	it("ignores assigned-port holders for a task with no running dev server", async () => {
		const taskId = "task-nodev-1";
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([{ taskId, tmuxSocket: "dev3" }]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\np1380\nccom.docker.backend\nn*:10569\n",
			allPanes: "100\tdev3-task-nod\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId,
			ports: [{ port: 3000, pid: 100, processName: "node" }],
		});
	});

	it("stopPortScanPoller prevents further polls", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([]);

		startPortScanPoller(push, getActiveSessions);
		stopPortScanPoller();

		await vi.advanceTimersByTimeAsync(20_000);
		expect(getActiveSessions).not.toHaveBeenCalled();
	});
});

describe("native task panes", () => {
	const TASK = "natv1234-aaaa-bbbb-cccc-ddddeeeeffff";
	// host 10 -> shell 11 -> node 12; pane-2: host 20 whose shell 21 was reparented away.
	const tree = new Map<number, number[]>([[1, [10, 20, 21]], [10, [11]], [11, [12]]]);
	const listTaskIds = vi.fn((): string[] => []);
	const readPanes = vi.fn((_taskId: string): Array<{ hostPid: number; shellPid: number; command: string[] }> => []);

	function records(panes: Array<{ host: number; shell: number; command?: string[] }>) {
		readPanes.mockReturnValue(panes.map((p) => ({ hostPid: p.host, shellPid: p.shell, command: p.command ?? ["zsh"] })));
	}

	beforeEach(() => {
		listTaskIds.mockReset().mockReturnValue([]);
		readPanes.mockReset().mockReturnValue([]);
		setNativePaneRecordsReader({ listTaskIds, readPanes });
	});

	it("keeps panes whose host still owns their shell and drops the rest", () => {
		expect(nativeTaskPaneRoots(TASK, tree)).toEqual([]);
		records([{ host: 10, shell: 11, command: ["sh", "run.sh"] }, { host: 20, shell: 99 }, { host: 30, shell: 31 }]);
		expect(nativeTaskPaneRoots(TASK, tree)).toEqual([{ shellPid: 11, command: ["sh", "run.sh"] }]);
		expect(readPanes).toHaveBeenCalledWith(TASK);
	});

	describe("poller", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.useFakeTimers();
			clearProcessInfoCache();
			stopPortScanPoller();
		});

		afterEach(() => {
			stopPortScanPoller();
			vi.useRealTimers();
		});

		const NATIVE_PS = "  10     1   1000   0.0\n  11    10   2000   0.0\n  12    11   3000   0.0\n";
		const NATIVE_LSOF = "p12\ncnode\nn*:5173\n";

		it("still polls an unbound native task whose aux pane outlived the primary shell", async () => {
			listTaskIds.mockReturnValue([TASK]);
			records([{ host: 10, shell: 11 }]);
			routeSpawnByArgv({ ps: NATIVE_PS, lsof: NATIVE_LSOF });
			const push = vi.fn();

			startPortScanPoller(push, () => []);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(push).toHaveBeenCalledWith("portsUpdated", {
				taskId: TASK,
				ports: [{ port: 5173, pid: 12, processName: "node" }],
			});
		});

		it("ignores an on-disk native task with no live pane, and one already bound", async () => {
			// A fresh id: the poller's port cache outlives a test.
			const bound = "bound000-aaaa-bbbb-cccc-ddddeeeeffff";
			listTaskIds.mockReturnValue([bound, "dead0000-aaaa-bbbb-cccc-ddddeeeeffff"]);
			readPanes.mockImplementation((id: string) =>
				id === bound ? [{ hostPid: 10, shellPid: 11, command: [] }] : [{ hostPid: 77, shellPid: 78, command: [] }]);
			routeSpawnByArgv({ ps: NATIVE_PS, lsof: NATIVE_LSOF });
			const push = vi.fn();

			startPortScanPoller(push, () => [{ taskId: bound, tmuxSocket: "" }]);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(push.mock.calls.map((c) => c[1].taskId)).toEqual([bound]);
			// Each task's records are read once per cycle, so a task cannot be added twice.
			expect(readPanes.mock.calls.map((c) => c[0])).toEqual([bound, "dead0000-aaaa-bbbb-cccc-ddddeeeeffff"]);
		});

		it("keeps a native task's ports and tunnels when the process table comes back empty", async () => {
			const id = "empty000-aaaa-bbbb-cccc-ddddeeeeffff";
			listTaskIds.mockReturnValue([id]);
			records([{ host: 10, shell: 11 }]);
			routeSpawnByArgv({ ps: NATIVE_PS, lsof: NATIVE_LSOF });
			const push = vi.fn();

			startPortScanPoller(push, () => []);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(push).toHaveBeenCalledTimes(1);

			routeSpawnByArgv({ ps: "", lsof: NATIVE_LSOF });
			clearProcessInfoCache();
			await vi.advanceTimersByTimeAsync(10_000);

			expect(push).toHaveBeenCalledTimes(1);
			expect(cleanupTaskTunnels).not.toHaveBeenCalledWith(id);
			expect(getPortsForTask(id)).toHaveLength(1);
		});

		it("does not scan native sessions on win32, where ps and lsof do not exist", async () => {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				records([{ host: 10, shell: 11 }]);
				listTaskIds.mockReturnValue([TASK]);
				const push = vi.fn();

				startPortScanPoller(push, () => [{ taskId: TASK, tmuxSocket: "" }]);
				await vi.advanceTimersByTimeAsync(10_000);

				expect(mockSpawn).not.toHaveBeenCalled();
				expect(readPanes).not.toHaveBeenCalled();
				expect(push).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
		});

		it("finds a native task's ports from the shell tree and never asks tmux with an empty socket", async () => {
			records([{ host: 10, shell: 11 }]);
			routeSpawnByArgv({
				ps: "  10     1   1000   0.0\n  11    10   2000   0.0\n  12    11   3000   0.0\n",
				lsof: "p12\ncnode\nn*:5173\np99\ncother\nn*:9999\n",
			});
			const push = vi.fn();

			startPortScanPoller(push, () => [{ taskId: TASK, tmuxSocket: "" }]);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(push).toHaveBeenCalledWith("portsUpdated", {
				taskId: TASK,
				ports: [{ port: 5173, pid: 12, processName: "node" }],
			});
			expect(mockSpawn.mock.calls.filter((args: any) => args[0][0] === "tmux")).toEqual([]);
		});
	});
});
