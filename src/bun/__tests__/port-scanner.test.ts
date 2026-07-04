import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawn/spawnSync before importing port-scanner
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// Mock pty-server to avoid side-effects
vi.mock("../pty-server", () => ({
	tmuxArgs: (socket: string, ...args: string[]) =>
		["tmux", "-L", socket, ...args],
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

import {
	parseLsofOutput,
	getDescendantPids,
	getSessionPanePids,
	getAllSessionPanePids,
	parseAllSessionPanePids,
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
	it("parses valid lsof -F output", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"p456",
			"cbun",
			"n127.0.0.1:8080",
		].join("\n");

		const pidSet = new Set([123, 456]);
		const result = parseLsofOutput(output, pidSet);

		expect(result).toEqual([
			{ port: 3000, pid: 123, processName: "node" },
			{ port: 8080, pid: 456, processName: "bun" },
		]);
	});

	it("filters by PID set", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"p999",
			"cpython3",
			"n*:5000",
		].join("\n");

		const pidSet = new Set([123]);
		const result = parseLsofOutput(output, pidSet);

		expect(result).toHaveLength(1);
		expect(result[0].port).toBe(3000);
	});

	it("returns empty array for empty output", () => {
		expect(parseLsofOutput("", new Set())).toEqual([]);
	});

	it("handles malformed lines gracefully", () => {
		const output = [
			"p123",
			"cnode",
			"ngarbage-no-port",
			"n*:3000",
		].join("\n");

		const result = parseLsofOutput(output, new Set([123]));
		expect(result).toEqual([
			{ port: 3000, pid: 123, processName: "node" },
		]);
	});

	it("deduplicates ports", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"n127.0.0.1:3000",
		].join("\n");

		const result = parseLsofOutput(output, new Set([123]));
		expect(result).toHaveLength(1);
	});

	it("sorts ports numerically", () => {
		const output = [
			"p123",
			"cnode",
			"n*:8080",
			"n*:3000",
			"n*:5173",
		].join("\n");

		const result = parseLsofOutput(output, new Set([123]));
		expect(result.map((p) => p.port)).toEqual([3000, 5173, 8080]);
	});

	it("rejects port 0", () => {
		const output = "p123\ncnode\nn*:0\n";
		const result = parseLsofOutput(output, new Set([123]));
		expect(result).toEqual([]);
	});

	it("rejects port above 65535", () => {
		const output = "p123\ncnode\nn*:70000\n";
		const result = parseLsofOutput(output, new Set([123]));
		expect(result).toEqual([]);
	});

	it("accepts port 65535", () => {
		const output = "p123\ncnode\nn*:65535\n";
		const result = parseLsofOutput(output, new Set([123]));
		expect(result).toHaveLength(1);
		expect(result[0].port).toBe(65535);
	});
});

describe("parsePortHolders", () => {
	it("returns holders of the requested ports regardless of owner pid", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
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

	it("ignores ports outside the requested set", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"n*:5173",
		].join("\n");

		const result = parsePortHolders(output, new Set([5173]));
		expect(result).toEqual([{ port: 5173, pid: 123, processName: "node" }]);
	});

	it("deduplicates a port bound on multiple interfaces", () => {
		const output = [
			"p123",
			"cnode",
			"n*:3000",
			"n127.0.0.1:3000",
		].join("\n");

		const result = parsePortHolders(output, new Set([3000]));
		expect(result).toHaveLength(1);
	});

	it("handles malformed network lines gracefully", () => {
		const output = "p123\ncnode\nngarbage-no-port\nn*:3000\n";
		const result = parsePortHolders(output, new Set([3000]));
		expect(result).toEqual([{ port: 3000, pid: 123, processName: "node" }]);
	});
});

describe("parseProcessInfoOutput", () => {
	it("parses ps output into tree and resources", () => {
		const { tree, resources } = parseProcessInfoOutput(
			"  100     1   204800   5.2\n  200   100   102400   2.1\n  300   200    51200   0.5\n",
		);

		expect(tree.get(1)).toEqual([100]);
		expect(tree.get(100)).toEqual([200]);
		expect(tree.get(200)).toEqual([300]);

		expect(resources.get(100)).toEqual({ rss: 204800 * 1024, cpu: 5.2 });
		expect(resources.get(200)).toEqual({ rss: 102400 * 1024, cpu: 2.1 });
		expect(resources.get(300)).toEqual({ rss: 51200 * 1024, cpu: 0.5 });
	});

	it("skips malformed lines", () => {
		const { tree } = parseProcessInfoOutput("garbage\n  100     1   1000   0.1\n");
		expect(tree.get(1)).toEqual([100]);
		expect(tree.size).toBe(1);
	});
});

describe("parseAllSessionPanePids", () => {
	it("groups pane PIDs by session name", () => {
		const output = [
			"dev3-abc12345\t100",
			"dev3-abc12345\t101",
			"dev3-dev-abc12345\t500",
			"dev3-other000\t200",
		].join("\n");

		const map = parseAllSessionPanePids(output);
		expect(map.get("dev3-abc12345")).toEqual([100, 101]);
		expect(map.get("dev3-dev-abc12345")).toEqual([500]);
		expect(map.get("dev3-other000")).toEqual([200]);
	});

	it("returns empty map for empty output", () => {
		expect(parseAllSessionPanePids("").size).toBe(0);
	});

	it("skips malformed lines", () => {
		const map = parseAllSessionPanePids("no-tab-here\ndev3-ok000000\t42\n\tmissing-session\ndev3-bad00000\tNaN\n");
		expect([...map.keys()]).toEqual(["dev3-ok000000"]);
		expect(map.get("dev3-ok000000")).toEqual([42]);
	});
});

describe("getAllSessionPanePids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("runs a single tmux list-panes -a call", async () => {
		mockSpawn.mockReturnValue(makeProc("dev3-abc12345\t100\ndev3-def00000\t200\n"));

		const map = await getAllSessionPanePids("dev3");
		expect(map.get("dev3-abc12345")).toEqual([100]);
		expect(map.get("dev3-def00000")).toEqual([200]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const [argv] = mockSpawn.mock.calls[0];
		expect(argv).toContain("list-panes");
		expect(argv).toContain("-a");
	});

	it("returns empty map when tmux fails", async () => {
		mockSpawn.mockReturnValue(makeProc("", 1));
		const map = await getAllSessionPanePids("dev3");
		expect(map.size).toBe(0);
	});
});

describe("findPortHolders", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty for an empty port list without spawning lsof", async () => {
		expect(await findPortHolders([])).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("uses provided lsof output without spawning", async () => {
		const output = "p123\ncnode\nn*:3000\n";
		const result = await findPortHolders([3000], output);
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

	it("returns immediately when the ports are already free", async () => {
		mockSpawn.mockReturnValue(makeProc(""));
		const holders = await waitForPortsFree([3000], 5000, 10);
		expect(holders).toEqual([]);
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

	it("returns immediately for an empty port list", async () => {
		const holders = await waitForPortsFree([], 5000, 10);
		expect(holders).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();
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

	it("returns children for a single level", async () => {
		mockSpawn.mockReturnValue(makeProc("100 1 0 0.0\n200 100 0 0.0\n201 100 0 0.0\n"));

		const result = await getDescendantPids(100);
		expect(result).toEqual([200, 201]);
	});

	it("returns empty for no children", async () => {
		mockSpawn.mockReturnValue(makeProc("100 1 0 0.0\n"));

		const result = await getDescendantPids(100);
		expect(result).toEqual([]);
	});

	it("handles deep nesting", async () => {
		mockSpawn.mockReturnValue(makeProc("100 1 0 0.0\n200 100 0 0.0\n300 200 0 0.0\n"));

		const result = await getDescendantPids(100);
		expect(result).toEqual([200, 300]);
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

	it("returns pane PIDs from tmux output", async () => {
		mockSpawn.mockReturnValue(makeProc("12345\n67890\n"));

		const result = await getSessionPanePids("dev3", "dev3-abc12345");
		expect(result).toEqual([12345, 67890]);
	});

	it("returns empty on tmux failure", async () => {
		mockSpawn.mockReturnValue(makeProc("", 1));

		const result = await getSessionPanePids("dev3", "dev3-abc12345");
		expect(result).toEqual([]);
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

	it("returns empty string on failure", async () => {
		mockSpawn.mockReturnValue(makeProc("", 1));
		const result = await getLsofOutput();
		expect(result).toBe("");
	});

	it("returns empty string on exception", async () => {
		mockSpawn.mockImplementation(() => { throw new Error("boom"); });
		const result = await getLsofOutput();
		expect(result).toBe("");
	});
});

describe("collectProcessInfo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProcessInfoCache();
	});

	it("parses ps output into tree and resources", async () => {
		mockSpawn.mockReturnValueOnce(
			makeProc("  100     1   204800   5.2\n  200   100   102400   2.1\n  300   200    51200   0.5\n"),
		);

		const { tree, resources } = await collectProcessInfo();

		expect(tree.get(1)).toEqual([100]);
		expect(tree.get(100)).toEqual([200]);
		expect(tree.get(200)).toEqual([300]);

		expect(resources.get(100)).toEqual({ rss: 204800 * 1024, cpu: 5.2 });
		expect(resources.get(200)).toEqual({ rss: 102400 * 1024, cpu: 2.1 });
		expect(resources.get(300)).toEqual({ rss: 51200 * 1024, cpu: 0.5 });
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

	it("returns empty map on ps failure", async () => {
		mockSpawn.mockReturnValueOnce(makeProc("", 1));
		const tree = await buildProcessTree();
		expect(tree.size).toBe(0);
	});

	it("returns empty map on exception", async () => {
		mockSpawn.mockImplementation(() => { throw new Error("boom"); });
		const tree = await buildProcessTree();
		expect(tree.size).toBe(0);
	});
});

describe("collectDescendants", () => {
	it("returns all descendants via in-memory BFS", () => {
		const tree = new Map<number, number[]>([
			[1, [100]],
			[100, [200, 300]],
			[200, [400]],
		]);

		const result = collectDescendants(100, tree);
		expect(result).toEqual([200, 300, 400]);
	});

	it("returns empty for leaf PID", () => {
		const tree = new Map<number, number[]>([[1, [100]]]);
		const result = collectDescendants(100, tree);
		expect(result).toEqual([]);
	});

	it("returns empty for unknown PID", () => {
		const tree = new Map<number, number[]>();
		const result = collectDescendants(999, tree);
		expect(result).toEqual([]);
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

	it("handles missing dev server session gracefully", async () => {
		routeSpawnByArgv({
			ps: "100 1 0 0.0\n",
			panes: { "dev3-abc12345": "100\n" }, // dev session unrouted → exit 1
		});

		const pids = await collectTaskPids("dev3", "dev3-abc12345");
		expect(pids).toEqual(new Set([100]));
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

	it("returns empty when no pane PIDs", async () => {
		routeSpawnByArgv({});

		const result = await scanTaskPorts("dev3", "dev3-abc12345");
		expect(result).toEqual([]);
	});

	it("orchestrates pane PIDs, descendants, and lsof parsing", async () => {
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

	it("pushes portsUpdated when ports change", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-1234-5678-abcd", tmuxSocket: "dev3" },
		]);

		routeSpawnByArgv({
			ps: "  100     1   50000   0.0\n",
			lsof: "p100\ncnode\nn*:3000\n",
			allPanes: "dev3-task-123\t100\n",
		});

		startPortScanPoller(push, getActiveSessions);

		// Advance past first poll interval (async poll body)
		await vi.advanceTimersByTimeAsync(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId: "task-1234-5678-abcd",
			ports: [{ port: 3000, pid: 100, processName: "node" }],
		});
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
			allPanes: "dev3-task-aaa\t100\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);

		// Batched: 3 spawns total for 3 sessions — NOT 2 per session.
		expect(mockSpawn).toHaveBeenCalledTimes(3);
		const argv0s = mockSpawn.mock.calls.map((args: any) => args[0][0]).sort();
		expect(argv0s).toEqual(["lsof", "ps", "tmux"]);
	});

	it("does not push when ports are unchanged", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-unchanged-test", tmuxSocket: "dev3" },
		]);

		routeSpawnByArgv({
			ps: "  500     1   60000   0.0\n",
			lsof: "p500\ncnode\nn*:4000\n",
			allPanes: "dev3-task-unc\t500\n",
		});

		startPortScanPoller(push, getActiveSessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll cycle — same ports
		await vi.advanceTimersByTimeAsync(10_000);
		// Should still be 1 (no second push)
		expect(push).toHaveBeenCalledTimes(1);
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
			allPanes: "dev3-task-aaa\t100\ndev3-task-bbb\t200\n",
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
			allPanes: "dev3-task-aaa\t100\n",
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

	it("stopPortScanPoller prevents further polls", async () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([]);

		startPortScanPoller(push, getActiveSessions);
		stopPortScanPoller();

		await vi.advanceTimersByTimeAsync(20_000);
		expect(getActiveSessions).not.toHaveBeenCalled();
	});
});
