import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { parseLsofOutput, getDescendantPids, getSessionPanePids, scanTaskPorts } from "../port-scanner";
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
});
