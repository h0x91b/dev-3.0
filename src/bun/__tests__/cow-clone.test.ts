import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawn before importing the module
const mockSpawn = vi.fn();
vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockCp = vi.fn(async () => undefined);
const mockRm = vi.fn(async () => undefined);
const mockMkdir = vi.fn(async () => undefined);
vi.mock("node:fs/promises", () => ({
	cp: (...args: unknown[]) => mockCp(...(args as [])),
	rm: (...args: unknown[]) => mockRm(...(args as [])),
	mkdir: (...args: unknown[]) => mockMkdir(...(args as [])),
}));
vi.mock("node:fs", () => ({ existsSync: () => true }));

// Mock logger
vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	}),
}));

import { clonePaths, detectClonePaths, WELL_KNOWN_CLONE_PATHS } from "../cow-clone";

function makeProc(exitCode: number, stderr = "") {
	return {
		exited: Promise.resolve(exitCode),
		stderr: stderr ? new Response(stderr).body : undefined,
	};
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

	// The cascade's last step has nothing behind it: whatever it reports is the
	// truth about whether the path is in the worktree (issue #1728).
	describe("final cp -R fallback", () => {
		const origPlatform = process.platform;
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "linux", writable: true });
		});
		afterEach(() => {
			Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
		});

		function cascade(finalCopyExit: number, stderr = "") {
			mockSpawn.mockImplementation((cmd: string[]) => {
				if (cmd[0] !== "cp") return makeProc(0);
				if (cmd.includes("--reflink=always")) return makeProc(1, "cp: --reflink unsupported");
				return makeProc(finalCopyExit, stderr);
			});
		}

		it("reports success with no error when the plain copy succeeds", async () => {
			cascade(0);
			const results = await clonePaths("/src", "/dst", ["node_modules"]);
			expect(results[0]).toMatchObject({ path: "node_modules", method: "copy" });
			expect(results[0].error).toBeUndefined();
			expect(results[0].skipped).toBeUndefined();
		});

		it("reports a failure with the exit code and stderr when the plain copy fails", async () => {
			cascade(1, "cp: /src/.env: Permission denied");
			const results = await clonePaths("/src", "/dst", [".env"]);
			expect(results).toHaveLength(1);
			expect(results[0].error).toContain("Permission denied");
			expect(results[0].error).toContain("exited 1");
			expect(results[0].skipped).toBeUndefined();
		});

		it("still reports the exit code when the command wrote nothing to stderr", async () => {
			cascade(2);
			const results = await clonePaths("/src", "/dst", [".env"]);
			expect(results[0].error).toBe("cp -R exited 2");
		});

		it("never marks a failed path as copied, even alongside a successful one", async () => {
			mockSpawn.mockImplementation((cmd: string[]) => {
				if (cmd[0] !== "cp") return makeProc(0);
				if (cmd.includes("--reflink=always")) return makeProc(1);
				return cmd.includes("/src/.env")
					? makeProc(1, "cp: /src/.env: Permission denied")
					: makeProc(0);
			});

			const results = await clonePaths("/src", "/dst", ["node_modules", ".env"]);
			const ok = results.find((r) => r.path === "node_modules")!;
			const bad = results.find((r) => r.path === ".env")!;
			expect(ok.error).toBeUndefined();
			expect(bad.error).toBeDefined();
			// A summary that counted this as a copy is exactly the reported bug.
			expect(results.filter((r) => !r.error && !r.skipped)).toHaveLength(1);
		});

		it("keeps a missing source a skip, not a failure", async () => {
			mockSpawn.mockImplementation((cmd: string[]) => (
				cmd[0] === "test" ? makeProc(1) : makeProc(0)
			));
			const results = await clonePaths("/src", "/dst", ["node_modules"]);
			expect(results[0].skipped).toBe(true);
			expect(results[0].error).toBeUndefined();
			// Nothing was copied, so no cp ran at all.
			expect(mockSpawn.mock.calls.some((c: unknown[]) => (c[0] as string[])[0] === "cp")).toBe(false);
		});
	});

	describe("on Windows", () => {
		const origPlatform = process.platform;
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "win32", writable: true });
		});
		afterEach(() => {
			Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
			// clearAllMocks keeps implementations, so a rigged cp would outlive this block.
			mockCp.mockImplementation((async () => undefined) as never);
		});

		it("copies through node:fs without spawning a POSIX binary", async () => {
			const results = await clonePaths("D:\\src\\repo", "C:/wt/worktree", ["node_modules"]);

			expect(results).toEqual([expect.objectContaining({ path: "node_modules", method: "copy" })]);
			expect(results[0].skipped).toBeUndefined();
			expect(mockCp).toHaveBeenCalledWith("D:\\src\\repo/node_modules", "C:/wt/worktree/node_modules", {
				recursive: true,
				force: true,
			});
			// `cp`/`rm`/`mkdir`/`test` are not Windows binaries.
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("creates the destination parent for a nested path", async () => {
			await clonePaths("D:\\src\\repo", "C:/wt/worktree", ["frontend/node_modules"]);
			expect(mockMkdir).toHaveBeenCalledWith("C:/wt/worktree/frontend", { recursive: true });
		});

		it("turns a copy error into a failed result instead of rejecting the whole clone", async () => {
			mockCp.mockImplementation((async (src: string) => {
				if (src.endsWith("node_modules")) throw new Error("EPERM: operation not permitted");
			}) as never);
			const results = await clonePaths("D:\\src\\repo", "C:/wt/worktree", ["node_modules", ".env"]);
			expect(results.find((r) => r.path === "node_modules")!.error).toContain("EPERM");
			expect(results.find((r) => r.path === ".env")!.error).toBeUndefined();
		});
	});
});

describe("WELL_KNOWN_CLONE_PATHS", () => {
	it("contains common dependency directories", () => {
		expect(WELL_KNOWN_CLONE_PATHS).toContain("node_modules");
		expect(WELL_KNOWN_CLONE_PATHS).toContain(".venv");
		expect(WELL_KNOWN_CLONE_PATHS).toContain("vendor/bundle");
		expect(WELL_KNOWN_CLONE_PATHS).toContain("target");
		expect(WELL_KNOWN_CLONE_PATHS).toContain(".env");
		expect(WELL_KNOWN_CLONE_PATHS).toContain(".npmrc");
	});

	it("contains no absolute paths", () => {
		for (const p of WELL_KNOWN_CLONE_PATHS) {
			expect(p.startsWith("/")).toBe(false);
		}
	});

	it("contains no path traversal", () => {
		for (const p of WELL_KNOWN_CLONE_PATHS) {
			expect(p.split("/")).not.toContain("..");
		}
	});
});

describe("glob patterns", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects glob paths with traversal", async () => {
		await expect(
			clonePaths("/src", "/dst", ["../*.cache"]),
		).rejects.toThrow("Path traversal not allowed");
	});

	it("allows valid glob patterns", async () => {
		// Non-glob paths that exist → normal flow
		// Glob patterns → expandGlob is called (which uses Bun.Glob)
		// In vitest env, Bun.Glob doesn't exist, so expandGlob returns []
		// That means no expanded paths → nothing to clone → empty results for the glob
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test") return makeProc(1); // nothing exists
			return makeProc(0);
		});

		// Should not throw for valid glob patterns
		const results = await clonePaths("/src", "/dst", ["*.cache"]);
		// Glob expansion fails gracefully in vitest (no Bun.Glob) → empty results
		expect(results).toHaveLength(0);
	});

	it("allows glob with directory prefix", async () => {
		mockSpawn.mockImplementation(() => makeProc(1));
		// Should not throw
		const results = await clonePaths("/src", "/dst", ["src/**/node_modules"]);
		expect(results).toHaveLength(0);
	});

	it("rejects absolute path even with glob characters", async () => {
		await expect(
			clonePaths("/src", "/dst", ["/*.cache"]),
		).rejects.toThrow("Absolute path not allowed");
	});

	it("deduplicates expanded paths", async () => {
		// If two globs expand to the same path, it should be cloned only once
		// Can't fully test with Bun.Glob in vitest, but we can test the non-glob dedup
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

		// Same path listed twice — should only clone once
		const results = await clonePaths("/src", "/dst", ["node_modules", "node_modules"]);
		expect(results).toHaveLength(1);
		expect(results[0].path).toBe("node_modules");
	});

	it("mixes globs and literal paths", async () => {
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

		// Literal path works, glob silently returns empty in vitest
		const results = await clonePaths("/src", "/dst", ["node_modules", "*.cache"]);
		// node_modules is literal → cloned; *.cache is glob → Bun.Glob fails gracefully → 0 expanded
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.find((r) => r.path === "node_modules")).toBeDefined();
	});
});

describe("detectClonePaths", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns only paths that exist in the project", async () => {
		const existingPaths = new Set([
			"/proj/node_modules",
			"/proj/.env",
			"/proj/.venv",
		]);

		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test" && cmd[1] === "-e") {
				const path = cmd[2];
				return makeProc(existingPaths.has(path) ? 0 : 1);
			}
			return makeProc(0);
		});

		const detected = await detectClonePaths("/proj");
		expect(detected).toContain("node_modules");
		expect(detected).toContain(".env");
		expect(detected).toContain(".venv");
		// Something that doesn't exist should not be included
		expect(detected).not.toContain("Pods");
		expect(detected).not.toContain(".gradle");
	});

	it("returns empty array when nothing exists", async () => {
		mockSpawn.mockImplementation(() => makeProc(1));

		const detected = await detectClonePaths("/empty-proj");
		expect(detected).toEqual([]);
	});

	it("deduplicates well-known paths", async () => {
		// "vendor" and "build" appear for multiple ecosystems
		// detectClonePaths should deduplicate
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "test" && cmd[2] === "/proj/vendor") return makeProc(0);
			return makeProc(1);
		});

		const detected = await detectClonePaths("/proj");
		const vendorCount = detected.filter((p) => p === "vendor").length;
		expect(vendorCount).toBe(1);
	});
});
