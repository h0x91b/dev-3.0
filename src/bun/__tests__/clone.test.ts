import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

const mockSpawn = vi.fn();

vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// Import after mocks are set up.
// bun:ffi is NOT available in vitest (Node.js), so clonefileFn is null by default.
// We use _setClonefileFn to inject a mock for testing the clonefile path.
const { validateClonePath, cloneSingle, clonePathsToWorktree, _setClonefileFn } = await import("../clone");

const mockClonefile = vi.fn();

// ---- Helpers ----

function makeSpawnResult(exitCode: number, stderr = "") {
	const stderrStream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(stderr));
			controller.close();
		},
	});
	const stdoutStream = new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
	return {
		pid: 0,
		exited: Promise.resolve(exitCode),
		stdout: stdoutStream,
		stderr: stderrStream,
		kill: vi.fn(),
	};
}

/** Configure mockSpawn to handle different commands differently. */
function configureSpawn(handlers: Record<string, { exitCode: number; stderr?: string }>) {
	mockSpawn.mockImplementation((cmd: string[], _opts?: unknown) => {
		const cmdStr = cmd.join(" ");
		for (const [pattern, result] of Object.entries(handlers)) {
			if (cmdStr.includes(pattern)) {
				return makeSpawnResult(result.exitCode, result.stderr ?? "");
			}
		}
		// Default: success
		return makeSpawnResult(0);
	});
}

// ---- Tests ----

describe("validateClonePath", () => {
	it("rejects absolute paths", () => {
		expect(validateClonePath("/etc/passwd")).toBe("absolute paths not allowed");
		expect(validateClonePath("/home/user/dir")).toBe("absolute paths not allowed");
	});

	it("rejects paths with ..", () => {
		expect(validateClonePath("../../../etc/passwd")).toBe('paths containing ".." not allowed');
		expect(validateClonePath("foo/../bar")).toBe('paths containing ".." not allowed');
		expect(validateClonePath("..")).toBe('paths containing ".." not allowed');
	});

	it("accepts valid relative paths", () => {
		expect(validateClonePath("node_modules")).toBeNull();
		expect(validateClonePath(".venv")).toBeNull();
		expect(validateClonePath("frontend/build")).toBeNull();
		expect(validateClonePath("deeply/nested/dir")).toBeNull();
	});

	it("accepts paths with dots that are not ..", () => {
		expect(validateClonePath(".hidden")).toBeNull();
		expect(validateClonePath("file.txt")).toBeNull();
		expect(validateClonePath(".config/settings")).toBeNull();
	});
});

describe("cloneSingle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Inject mock clonefile for each test (simulates macOS FFI)
		_setClonefileFn(mockClonefile);
	});

	afterEach(() => {
		// Reset to null (no FFI) after each test
		_setClonefileFn(null);
	});

	it("skips non-existent source paths", async () => {
		// `test -e` returns 1 (path doesn't exist)
		configureSpawn({ "test -e": { exitCode: 1 } });

		const result = await cloneSingle("/src", "/dst", "node_modules");
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
	});

	it("uses clonefile on macOS when FFI is available", async () => {
		mockClonefile.mockReturnValue(true); // success
		configureSpawn({
			"test -e": { exitCode: 0 }, // source exists
			"mkdir -p": { exitCode: 0 },
		});

		const result = await cloneSingle("/src", "/dst", "node_modules");

		// On macOS, clonefile should be tried first
		if (process.platform === "darwin") {
			expect(mockClonefile).toHaveBeenCalledWith("/src/node_modules", "/dst/node_modules");
			expect(result.method).toBe("clonefile");
		}
		expect(result.ok).toBe(true);
	});

	it("falls back to cp -cR when clonefile fails on macOS", async () => {
		mockClonefile.mockReturnValue(false); // failure
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 0 }, // cp -cR succeeds
		});

		const result = await cloneSingle("/src", "/dst", "node_modules");

		if (process.platform === "darwin") {
			expect(mockClonefile).toHaveBeenCalled();
			expect(result.method).toBe("apfs-cp");
		}
		expect(result.ok).toBe(true);
	});

	it("falls back to cp -R when both clonefile and cp -cR fail on macOS", async () => {
		mockClonefile.mockReturnValue(false);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 1, stderr: "APFS not available" },
			"cp -R": { exitCode: 0 },
		});

		const result = await cloneSingle("/src", "/dst", "node_modules");

		if (process.platform === "darwin") {
			expect(result.method).toBe("copy");
		}
		expect(result.ok).toBe(true);
	});

	it("handles clonefile throwing an error", async () => {
		mockClonefile.mockImplementation(() => {
			throw new Error("FFI crash");
		});
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 0 },
		});

		const result = await cloneSingle("/src", "/dst", "node_modules");
		// Should recover and use cp -cR
		expect(result.ok).toBe(true);
	});

	it("ensures parent directories are created", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		await cloneSingle("/src", "/dst", "deeply/nested/dir");

		// Check that mkdir -p was called for the parent
		const mkdirCall = mockSpawn.mock.calls.find(
			(call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).includes("mkdir"),
		);
		expect(mkdirCall).toBeDefined();
		expect((mkdirCall![0] as string[]).join(" ")).toContain("/dst/deeply/nested");
	});

	it("reports failure when final fallback cp -R fails", async () => {
		mockClonefile.mockReturnValue(false);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 1, stderr: "no APFS" },
			"cp -R": { exitCode: 1, stderr: "permission denied" },
		});

		const result = await cloneSingle("/src", "/dst", "secret_dir");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("permission denied");
		expect(result.method).toBe("copy");
	});

	it("measures duration", async () => {
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});
		mockClonefile.mockReturnValue(true);

		const result = await cloneSingle("/src", "/dst", "foo");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof result.durationMs).toBe("number");
	});
});

describe("clonePathsToWorktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_setClonefileFn(mockClonefile);
	});

	afterEach(() => {
		_setClonefileFn(null);
	});

	it("returns empty array for empty clonePaths", async () => {
		const results = await clonePathsToWorktree("/src", "/dst", []);
		expect(results).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("filters out invalid paths", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		// Only "valid" should be cloned; the rest are invalid
		const results = await clonePathsToWorktree("/src", "/dst", [
			"/absolute/path",
			"../escape",
			"valid",
		]);

		// Should have only 1 result (for "valid")
		expect(results.length).toBe(1);
		expect(results[0].path).toBe("valid");
	});

	it("deduplicates paths", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		const results = await clonePathsToWorktree("/src", "/dst", [
			"node_modules",
			"node_modules",
			"node_modules",
		]);

		expect(results.length).toBe(1);
	});

	it("trims whitespace from paths", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		const results = await clonePathsToWorktree("/src", "/dst", [
			"  node_modules  ",
			"  .venv  ",
		]);

		expect(results.length).toBe(2);
		expect(results[0].path).toBe("node_modules");
		expect(results[1].path).toBe(".venv");
	});

	it("skips empty strings and whitespace-only", async () => {
		const results = await clonePathsToWorktree("/src", "/dst", ["", "  ", "   "]);
		expect(results).toEqual([]);
	});

	it("clones multiple paths in parallel", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		const results = await clonePathsToWorktree("/src", "/dst", [
			"node_modules",
			".venv",
			"build",
			"static",
			"secrets",
		]);

		expect(results.length).toBe(5);
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("continues when one path fails", async () => {
		let callCount = 0;
		mockClonefile.mockImplementation(() => {
			callCount++;
			// Fail on the second call
			return callCount === 2 ? false : true;
		});
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 0 }, // fallback succeeds
		});

		const results = await clonePathsToWorktree("/src", "/dst", [
			"path1",
			"path2",
			"path3",
		]);

		expect(results.length).toBe(3);
		// All should ultimately succeed (path2 falls back to cp -cR)
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("does not throw even when all paths fail", async () => {
		mockClonefile.mockReturnValue(false);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 1, stderr: "fail" },
			"cp -R": { exitCode: 1, stderr: "also fail" },
		});

		// Should NOT throw
		const results = await clonePathsToWorktree("/src", "/dst", [
			"path1",
			"path2",
		]);

		expect(results.length).toBe(2);
		expect(results.every((r) => !r.ok)).toBe(true);
	});

	it("skips paths that do not exist in source", async () => {
		// First "test -e" succeeds, second fails
		let testCount = 0;
		mockSpawn.mockImplementation((cmd: string[], _opts?: unknown) => {
			const cmdStr = cmd.join(" ");
			if (cmdStr.includes("test -e")) {
				testCount++;
				return makeSpawnResult(testCount === 1 ? 0 : 1);
			}
			if (cmdStr.includes("mkdir")) return makeSpawnResult(0);
			return makeSpawnResult(0);
		});
		mockClonefile.mockReturnValue(true);

		const results = await clonePathsToWorktree("/src", "/dst", [
			"exists",
			"doesnt_exist",
		]);

		// Both are returned but doesnt_exist is skipped
		const skipped = results.filter((r) => r.skipped);
		const cloned = results.filter((r) => !r.skipped);
		expect(skipped.length).toBe(1);
		expect(cloned.length).toBe(1);
		expect(cloned[0].path).toBe("exists");
	});

	it("handles mix of existing and non-existing paths", async () => {
		const existingPaths = new Set(["node_modules", "build"]);
		mockSpawn.mockImplementation((cmd: string[], _opts?: unknown) => {
			const cmdStr = cmd.join(" ");
			if (cmdStr.includes("test -e")) {
				const pathArg = cmd[2]; // test -e <path>
				const relPath = pathArg.split("/").pop()!;
				return makeSpawnResult(existingPaths.has(relPath) ? 0 : 1);
			}
			if (cmdStr.includes("mkdir")) return makeSpawnResult(0);
			return makeSpawnResult(0);
		});
		mockClonefile.mockReturnValue(true);

		const results = await clonePathsToWorktree("/src", "/dst", [
			"node_modules",
			".venv",
			"build",
		]);

		const cloned = results.filter((r) => !r.skipped);
		const skipped = results.filter((r) => r.skipped);
		expect(cloned.length).toBe(2);
		expect(skipped.length).toBe(1);
	});

	it("cleans up partial copy on clonefile failure before trying cp -cR", async () => {
		mockClonefile.mockReturnValue(false);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
			"rm -rf": { exitCode: 0 },
			"cp -cR": { exitCode: 0 },
		});

		await cloneSingle("/src", "/dst", "node_modules");

		if (process.platform === "darwin") {
			// rm -rf should have been called to clean up partial dst
			const rmCall = mockSpawn.mock.calls.find(
				(call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).includes("rm"),
			);
			expect(rmCall).toBeDefined();
		}
	});
});

describe("cloneSingle — path construction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_setClonefileFn(mockClonefile);
	});

	afterEach(() => {
		_setClonefileFn(null);
	});

	it("constructs correct source and destination paths", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		await cloneSingle("/project/root", "/worktree/path", "node_modules");

		if (process.platform === "darwin") {
			expect(mockClonefile).toHaveBeenCalledWith(
				"/project/root/node_modules",
				"/worktree/path/node_modules",
			);
		}
	});

	it("handles nested paths correctly", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		await cloneSingle("/src", "/dst", "frontend/node_modules");

		if (process.platform === "darwin") {
			expect(mockClonefile).toHaveBeenCalledWith(
				"/src/frontend/node_modules",
				"/dst/frontend/node_modules",
			);
		}
	});

	it("handles paths with spaces", async () => {
		mockClonefile.mockReturnValue(true);
		configureSpawn({
			"test -e": { exitCode: 0 },
			"mkdir -p": { exitCode: 0 },
		});

		await cloneSingle("/src", "/dst", "my folder/sub dir");

		if (process.platform === "darwin") {
			expect(mockClonefile).toHaveBeenCalledWith(
				"/src/my folder/sub dir",
				"/dst/my folder/sub dir",
			);
		}
	});
});

describe("clonePathsToWorktree — error resilience", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_setClonefileFn(mockClonefile);
	});

	afterEach(() => {
		_setClonefileFn(null);
	});

	it("handles spawn throwing unexpectedly", async () => {
		// pathExists needs to succeed (test -e), then spawn throws on subsequent calls
		let callCount = 0;
		mockSpawn.mockImplementation((cmd: string[]) => {
			callCount++;
			if (cmd.includes("test")) return makeSpawnResult(0); // source exists
			if (cmd.includes("mkdir")) return makeSpawnResult(0); // parent dir ok
			throw new Error("spawn failed completely");
		});
		mockClonefile.mockImplementation(() => {
			throw new Error("FFI crash");
		});

		// Should not throw
		const results = await clonePathsToWorktree("/src", "/dst", ["node_modules"]);

		// cloneSingle should have been called and caught the error gracefully
		expect(results.length).toBe(1);
		// The result may be ok (if a fallback cp succeeded) or not ok,
		// but the function should NOT throw
	});

	it("returns results even when Promise.allSettled catches rejections", async () => {
		// Make test -e succeed but cloneSingle reject
		let firstCall = true;
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd.includes("test")) {
				return makeSpawnResult(0);
			}
			if (firstCall) {
				firstCall = false;
				throw new Error("unexpected spawn error");
			}
			return makeSpawnResult(0);
		});
		mockClonefile.mockImplementation(() => {
			throw new Error("FFI broken");
		});

		const results = await clonePathsToWorktree("/src", "/dst", ["path1"]);
		expect(results.length).toBe(1);
	});
});
