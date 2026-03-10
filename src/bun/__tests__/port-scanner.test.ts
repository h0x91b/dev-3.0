import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawn/spawnSync before importing port-scanner
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// Mock pty-server to avoid side-effects
vi.mock("../pty-server", () => ({
	tmuxArgs: (socket: string | null, ...args: string[]) =>
		socket ? ["tmux", "-L", socket, ...args] : ["tmux", ...args],
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
	scanTaskPorts,
	getLsofOutput,
	collectTaskPids,
	startPortScanPoller,
	stopPortScanPoller,
	getPortsForTask,
} from "../port-scanner";
import { spawnSync } from "../spawn";

const mockSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;

function makeResult(stdout: string, exitCode = 0) {
	return {
		stdout: new TextEncoder().encode(stdout),
		stderr: new Uint8Array(),
		exitCode,
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

describe("getDescendantPids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns children for a single level", () => {
		mockSpawnSync
			.mockReturnValueOnce(makeResult("200\n201\n"))
			.mockReturnValueOnce(makeResult("", 1))
			.mockReturnValueOnce(makeResult("", 1));

		const result = getDescendantPids(100);
		expect(result).toEqual([200, 201]);
	});

	it("returns empty for no children", () => {
		mockSpawnSync.mockReturnValue(makeResult("", 1));

		const result = getDescendantPids(100);
		expect(result).toEqual([]);
	});

	it("handles deep nesting", () => {
		mockSpawnSync
			.mockReturnValueOnce(makeResult("200\n"))
			.mockReturnValueOnce(makeResult("300\n"))
			.mockReturnValueOnce(makeResult("", 1));

		const result = getDescendantPids(100);
		expect(result).toEqual([200, 300]);
	});
});

describe("getSessionPanePids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns pane PIDs from tmux output", () => {
		mockSpawnSync.mockReturnValue(makeResult("12345\n67890\n"));

		const result = getSessionPanePids("dev3", "dev3-abc12345");
		expect(result).toEqual([12345, 67890]);
	});

	it("returns empty on tmux failure", () => {
		mockSpawnSync.mockReturnValue(makeResult("", 1));

		const result = getSessionPanePids("dev3", "dev3-abc12345");
		expect(result).toEqual([]);
	});
});

describe("getLsofOutput", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns lsof stdout on success", () => {
		mockSpawnSync.mockReturnValue(makeResult("p123\ncnode\nn*:3000\n"));
		const result = getLsofOutput();
		expect(result).toBe("p123\ncnode\nn*:3000\n");
	});

	it("returns empty string on failure", () => {
		mockSpawnSync.mockReturnValue(makeResult("", 1));
		const result = getLsofOutput();
		expect(result).toBe("");
	});

	it("returns empty string on exception", () => {
		mockSpawnSync.mockImplementation(() => { throw new Error("boom"); });
		const result = getLsofOutput();
		expect(result).toBe("");
	});
});

describe("collectTaskPids", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns pane PIDs plus descendants", () => {
		mockSpawnSync
			// tmux list-panes
			.mockReturnValueOnce(makeResult("100\n"))
			// pgrep -P 100
			.mockReturnValueOnce(makeResult("200\n"))
			// pgrep -P 200
			.mockReturnValueOnce(makeResult("", 1));

		const pids = collectTaskPids("dev3", "dev3-abc12345");
		expect(pids).toEqual(new Set([100, 200]));
	});

	it("returns empty set when no pane PIDs", () => {
		mockSpawnSync.mockReturnValue(makeResult("", 1));
		const pids = collectTaskPids("dev3", "dev3-abc12345");
		expect(pids.size).toBe(0);
	});
});

describe("scanTaskPorts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty when no pane PIDs", () => {
		mockSpawnSync.mockReturnValue(makeResult("", 1));

		const result = scanTaskPorts("dev3", "dev3-abc12345");
		expect(result).toEqual([]);
	});

	it("orchestrates pane PIDs, descendants, and lsof parsing", () => {
		// First call: tmux list-panes
		mockSpawnSync
			.mockReturnValueOnce(makeResult("100\n"))
			// Second call: pgrep -P 100 (descendants)
			.mockReturnValueOnce(makeResult("200\n"))
			// Third call: pgrep -P 200 (no more descendants)
			.mockReturnValueOnce(makeResult("", 1))
			// Fourth call: lsof
			.mockReturnValueOnce(makeResult("p200\ncnode\nn*:3000\n"));

		const result = scanTaskPorts("dev3", "dev3-abc12345");
		expect(result).toEqual([
			{ port: 3000, pid: 200, processName: "node" },
		]);
	});

	it("uses pre-fetched lsof output when provided", () => {
		mockSpawnSync
			// tmux list-panes
			.mockReturnValueOnce(makeResult("100\n"))
			// pgrep -P 100
			.mockReturnValueOnce(makeResult("", 1));

		const lsofOutput = "p100\ncbun\nn*:8080\n";
		const result = scanTaskPorts("dev3", "dev3-abc12345", lsofOutput);
		expect(result).toEqual([
			{ port: 8080, pid: 100, processName: "bun" },
		]);
		// Should NOT have called lsof (only tmux + pgrep = 2 calls)
		expect(mockSpawnSync).toHaveBeenCalledTimes(2);
	});
});

describe("poller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		stopPortScanPoller();
	});

	afterEach(() => {
		stopPortScanPoller();
		vi.useRealTimers();
	});

	it("pushes portsUpdated when ports change", () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-1234-5678-abcd", tmuxSocket: "dev3" },
		]);

		mockSpawnSync
			// lsof (shared, called first)
			.mockReturnValueOnce(makeResult("p100\ncnode\nn*:3000\n"))
			// tmux list-panes for task
			.mockReturnValueOnce(makeResult("100\n"))
			// pgrep -P 100
			.mockReturnValueOnce(makeResult("", 1));

		startPortScanPoller(push, getActiveSessions);

		// Advance past first poll interval
		vi.advanceTimersByTime(10_000);

		expect(push).toHaveBeenCalledWith("portsUpdated", {
			taskId: "task-1234-5678-abcd",
			ports: [{ port: 3000, pid: 100, processName: "node" }],
		});
	});

	it("does not push when ports are unchanged", () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([
			{ taskId: "task-unchanged-test", tmuxSocket: "dev3" },
		]);

		// First poll cycle (lsof first, then tmux + pgrep)
		mockSpawnSync
			.mockReturnValueOnce(makeResult("p500\ncnode\nn*:4000\n"))
			.mockReturnValueOnce(makeResult("500\n"))
			.mockReturnValueOnce(makeResult("", 1));

		startPortScanPoller(push, getActiveSessions);
		vi.advanceTimersByTime(10_000);
		expect(push).toHaveBeenCalledTimes(1);

		// Second poll cycle — same ports
		mockSpawnSync
			.mockReturnValueOnce(makeResult("p500\ncnode\nn*:4000\n"))
			.mockReturnValueOnce(makeResult("500\n"))
			.mockReturnValueOnce(makeResult("", 1));

		vi.advanceTimersByTime(10_000);
		// Should still be 1 (no second push)
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("cleans up stale cache entries when sessions disappear", () => {
		const push = vi.fn();
		let sessions = [
			{ taskId: "task-aaaa", tmuxSocket: "dev3" as string | null },
			{ taskId: "task-bbbb", tmuxSocket: "dev3" as string | null },
		];
		const getActiveSessions = vi.fn().mockImplementation(() => sessions);

		// First poll: lsof (shared), then tmux+pgrep for each task
		mockSpawnSync
			// lsof (shared)
			.mockReturnValueOnce(makeResult("p100\ncnode\nn*:3000\np200\ncbun\nn*:8080\n"))
			// tmux pane for task-aaaa
			.mockReturnValueOnce(makeResult("100\n"))
			// pgrep for 100
			.mockReturnValueOnce(makeResult("", 1))
			// tmux pane for task-bbbb
			.mockReturnValueOnce(makeResult("200\n"))
			// pgrep for 200
			.mockReturnValueOnce(makeResult("", 1));

		startPortScanPoller(push, getActiveSessions);
		vi.advanceTimersByTime(10_000);
		expect(push).toHaveBeenCalledTimes(2);
		expect(getPortsForTask("task-aaaa")).toHaveLength(1);
		expect(getPortsForTask("task-bbbb")).toHaveLength(1);

		// Second poll: task-bbbb is gone
		sessions = [{ taskId: "task-aaaa", tmuxSocket: "dev3" }];
		mockSpawnSync
			// lsof (shared)
			.mockReturnValueOnce(makeResult("p100\ncnode\nn*:3000\n"))
			// tmux pane for task-aaaa
			.mockReturnValueOnce(makeResult("100\n"))
			// pgrep for 100
			.mockReturnValueOnce(makeResult("", 1));

		vi.advanceTimersByTime(10_000);
		expect(getPortsForTask("task-bbbb")).toEqual([]);
	});

	it("continues polling even if getActiveSessions throws", () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn()
			.mockImplementationOnce(() => { throw new Error("boom"); })
			.mockReturnValue([]);

		startPortScanPoller(push, getActiveSessions);

		// First poll — throws
		vi.advanceTimersByTime(10_000);
		expect(push).not.toHaveBeenCalled();

		// Second poll — should still fire (poller survived)
		vi.advanceTimersByTime(10_000);
		expect(getActiveSessions).toHaveBeenCalledTimes(2);
	});

	it("stopPortScanPoller prevents further polls", () => {
		const push = vi.fn();
		const getActiveSessions = vi.fn().mockReturnValue([]);

		startPortScanPoller(push, getActiveSessions);
		stopPortScanPoller();

		vi.advanceTimersByTime(20_000);
		expect(getActiveSessions).not.toHaveBeenCalled();
	});
});
