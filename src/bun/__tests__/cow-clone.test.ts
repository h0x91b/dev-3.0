import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawn before importing the module
const mockSpawn = vi.fn();
vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock logger
vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	}),
}));

import { clonePaths } from "../cow-clone";

function makeProc(exitCode: number) {
	return { exited: Promise.resolve(exitCode) };
}

describe("cow-clone", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty results for empty paths array", async () => {
		const results = await clonePaths("/src", "/dst", []);
		expect(results).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("skips non-existent source paths", async () => {
		// test -e → exit 1 (not found)
		mockSpawn.mockReturnValueOnce(makeProc(1));

		const results = await clonePaths("/src", "/dst", ["node_modules"]);
		expect(results).toHaveLength(1);
		expect(results[0].skipped).toBe(true);
		expect(results[0].path).toBe("node_modules");
	});

	it("rejects absolute paths", async () => {
		await expect(
			clonePaths("/src", "/dst", ["/etc/passwd"]),
		).rejects.toThrow("Absolute path not allowed");
	});

	it("rejects path traversal with ..", async () => {
		await expect(
			clonePaths("/src", "/dst", ["../secret"]),
		).rejects.toThrow("Path traversal not allowed");
	});

	it("rejects path traversal with embedded ..", async () => {
		await expect(
			clonePaths("/src", "/dst", ["foo/../../secret"]),
		).rejects.toThrow("Path traversal not allowed");
	});

	it("processes multiple paths in parallel", async () => {
		// For each path: test -e (exists), mkdir -p, rm -rf, then cp commands
		// Path 1: node_modules — test exists, mkdir, rm, then platform-specific
		// Path 2: .venv — test exists, mkdir, rm, then platform-specific
		// We'll make everything fall through to regular cp -R

		const callOrder: string[] = [];
		mockSpawn.mockImplementation((cmd: string[]) => {
			callOrder.push(cmd[0]);
			if (cmd[0] === "test") return makeProc(0); // exists
			if (cmd[0] === "mkdir") return makeProc(0);
			if (cmd[0] === "rm") return makeProc(0);
			if (cmd[0] === "cp") {
				// Make clonefile-style cp fail, regular cp succeed
				if (cmd.includes("-cR") || cmd.includes("--reflink=always")) {
					return makeProc(1);
				}
				return makeProc(0);
			}
			return makeProc(0);
		});

		const results = await clonePaths("/src", "/dst", ["node_modules", ".venv"]);
		expect(results).toHaveLength(2);
		expect(results[0].path).toBe("node_modules");
		expect(results[1].path).toBe(".venv");
		// Both should have completed (not skipped)
		expect(results[0].skipped).toBeUndefined();
		expect(results[1].skipped).toBeUndefined();
	});

	it("uses correct fallback chain on macOS", async () => {
		// Save and restore platform
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin", writable: true });

		const cpCalls: string[][] = [];
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test") return makeProc(0);
			if (cmd[0] === "mkdir") return makeProc(0);
			if (cmd[0] === "rm") return makeProc(0);
			if (cmd[0] === "cp") {
				cpCalls.push(cmd);
				// Make -cR fail, fall to regular cp
				if (cmd.includes("-cR")) return makeProc(1);
				return makeProc(0);
			}
			return makeProc(0);
		});

		// Note: clonefile FFI will fail in test env (no libSystem.B.dylib mock)
		// so it'll fall through to cp -cR, then to cp -R
		const results = await clonePaths("/src", "/dst", ["node_modules"]);
		expect(results).toHaveLength(1);
		// Should be either "apfs-clone" or "copy" depending on cp -cR success
		expect(["apfs-clone", "copy"]).toContain(results[0].method);

		Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
	});

	it("uses correct fallback chain on Linux", async () => {
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", writable: true });

		const cpCalls: string[][] = [];
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test") return makeProc(0);
			if (cmd[0] === "mkdir") return makeProc(0);
			if (cmd[0] === "rm") return makeProc(0);
			if (cmd[0] === "cp") {
				cpCalls.push(cmd);
				// reflink fails, fall to regular copy
				if (cmd.includes("--reflink=always")) return makeProc(1);
				return makeProc(0);
			}
			return makeProc(0);
		});

		const results = await clonePaths("/src", "/dst", ["node_modules"]);
		expect(results).toHaveLength(1);
		expect(results[0].method).toBe("copy");

		// Verify reflink was tried first
		const reflinkCall = cpCalls.find((c) => c.includes("--reflink=always"));
		expect(reflinkCall).toBeDefined();

		Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
	});

	it("handles nested paths correctly", async () => {
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test") return makeProc(0);
			if (cmd[0] === "mkdir") return makeProc(0);
			if (cmd[0] === "rm") return makeProc(0);
			if (cmd[0] === "cp") {
				if (cmd.includes("-cR") || cmd.includes("--reflink=always")) return makeProc(1);
				return makeProc(0);
			}
			return makeProc(0);
		});

		const results = await clonePaths("/src", "/dst", ["frontend/node_modules"]);
		expect(results).toHaveLength(1);
		expect(results[0].path).toBe("frontend/node_modules");

		// Verify mkdir -p was called for parent
		const mkdirCall = mockSpawn.mock.calls.find(
			(c: unknown[]) => (c[0] as string[])[0] === "mkdir",
		);
		expect(mkdirCall).toBeDefined();
		expect((mkdirCall![0] as string[]).join(" ")).toContain("/dst/frontend");
	});
});
