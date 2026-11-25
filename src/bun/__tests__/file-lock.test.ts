import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test the real file-lock module against the real filesystem (tmpdir).
// No mocking — this is an integration-level unit test.

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

import { withFileLock, FileLockTimeoutError } from "../file-lock";

describe("withFileLock — basic locking", () => {
	it("returns the callback's result and releases the lock", async () => {
		const filePath = path.join(tmpDir, "test.json");
		expect(await withFileLock(filePath, async () => 42)).toBe(42);
		expect(fs.existsSync(filePath + ".lock")).toBe(false);
	});

	it("releases the lock when the callback throws, propagating the error type", async () => {
		const filePath = path.join(tmpDir, "test.json");
		await expect(
			withFileLock(filePath, async () => {
				throw new TypeError("type mismatch");
			}),
		).rejects.toThrow(TypeError);
		expect(fs.existsSync(filePath + ".lock")).toBe(false);
	});
});

describe("withFileLock — mutual exclusion", () => {
	it("serializes concurrent operations on the same file", async () => {
		const filePath = path.join(tmpDir, "counter.json");
		fs.writeFileSync(filePath, "0");

		// Simulate 10 concurrent increments
		const increment = () =>
			withFileLock(filePath, async () => {
				const current = parseInt(fs.readFileSync(filePath, "utf-8"), 10);
				// Small delay to increase chance of race condition without lock
				await new Promise((resolve) => setTimeout(resolve, 5));
				fs.writeFileSync(filePath, String(current + 1));
			});

		await Promise.all(Array.from({ length: 10 }, () => increment()));

		const final = parseInt(fs.readFileSync(filePath, "utf-8"), 10);
		expect(final).toBe(10);
	});

	it("allows parallel operations on different files", async () => {
		const file1 = path.join(tmpDir, "a.json");
		const file2 = path.join(tmpDir, "b.json");

		const order: string[] = [];

		const op1 = withFileLock(file1, async () => {
			order.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("a-end");
		});

		const op2 = withFileLock(file2, async () => {
			order.push("b-start");
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("b-end");
		});

		await Promise.all([op1, op2]);

		// Both should have started before either finished (parallel execution)
		const aStartIdx = order.indexOf("a-start");
		const bStartIdx = order.indexOf("b-start");
		const aEndIdx = order.indexOf("a-end");
		const bEndIdx = order.indexOf("b-end");

		expect(aStartIdx).toBeLessThan(aEndIdx);
		expect(bStartIdx).toBeLessThan(bEndIdx);
		// At least one should start before the other ends (overlap)
		const hasOverlap =
			(aStartIdx < bEndIdx && bStartIdx < aEndIdx);
		expect(hasOverlap).toBe(true);
	});

});

describe("withFileLock — stale lock recovery", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Suppress expected "Breaking stale lock" warnings from the logger
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("does not break a fresh lock from another process", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const lockDir = filePath + ".lock";

		// Create a fresh lock
		fs.mkdirSync(lockDir);
		const now = new Date();
		fs.utimesSync(lockDir, now, now);

		// Should timeout, not break the lock
		await expect(
			withFileLock(filePath, async () => "never", { timeout: 200, staleThreshold: 60000 }),
		).rejects.toThrow(FileLockTimeoutError);

		// Lock should still exist (not broken)
		expect(fs.existsSync(lockDir)).toBe(true);

		// Clean up
		fs.rmdirSync(lockDir);
	});
});

describe("withFileLock — non-existent parent directory", () => {
	it("creates parent directories and acquires lock when parent dir does not exist", async () => {
		const deepPath = path.join(tmpDir, "deep", "nested", "dir", "tasks.json");
		const lockDir = deepPath + ".lock";

		// Parent directory does NOT exist — this simulates a brand-new project
		expect(fs.existsSync(path.dirname(deepPath))).toBe(false);

		const result = await withFileLock(deepPath, async () => {
			return "success";
		});

		expect(result).toBe("success");
		// Lock should be released after execution
		expect(fs.existsSync(lockDir)).toBe(false);
		// Parent directory should have been created
		expect(fs.existsSync(path.dirname(deepPath))).toBe(true);
	});

	it("serializes concurrent operations even when parent dir did not exist initially", async () => {
		const deepPath = path.join(tmpDir, "new-project", "tasks.json");
		let counter = 0;

		const increment = () =>
			withFileLock(deepPath, async () => {
				const current = counter;
				await new Promise((resolve) => setTimeout(resolve, 5));
				counter = current + 1;
			});

		await Promise.all(Array.from({ length: 5 }, () => increment()));
		expect(counter).toBe(5);
	});
});

describe("withFileLock — lock dir shape (backward compatibility)", () => {
	it("creates the lock as a plain empty directory at <filePath>.lock", async () => {
		const filePath = path.join(tmpDir, "fresh", "tasks.json");
		const lockDir = filePath + ".lock";

		let observedDir = false;
		let observedEmpty = false;
		let observedPath = "";

		await withFileLock(filePath, async () => {
			observedPath = lockDir;
			const stat = fs.statSync(lockDir);
			observedDir = stat.isDirectory();
			observedEmpty = fs.readdirSync(lockDir).length === 0;
		});

		expect(observedPath).toBe(filePath + ".lock");
		expect(observedDir).toBe(true);
		expect(observedEmpty).toBe(true);
		// Released afterwards.
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it("lock dir is interoperable with an older version (plain mkdir/rmdir)", async () => {
		const filePath = path.join(tmpDir, "interop", "tasks.json");
		const lockDir = filePath + ".lock";

		// New code acquires + releases (parent did not exist beforehand).
		await withFileLock(filePath, async () => "ok");

		// An older version acquires the SAME lock with a plain, non-recursive
		// mkdir and releases it with rmdir — must work without error.
		expect(() => fs.mkdirSync(lockDir)).not.toThrow();
		expect(() => fs.rmdirSync(lockDir)).not.toThrow();
	});
});

describe("withFileLock — stale-break backward compatibility", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("(a) breaks and acquires a stale lock created the OLD way (plain mkdir)", async () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		// Old version's lock: a plain empty directory with a stale mtime. No
		// payload, no extra files — exactly what a pre-fix version leaves behind.
		fs.mkdirSync(lockDir);
		const past = new Date(Date.now() - 30000);
		fs.utimesSync(lockDir, past, past);

		const result = await withFileLock(filePath, async () => "recovered", {
			staleThreshold: 5000,
		});

		expect(result).toBe("recovered");
		// Lock released; no graveyard litter left behind on the happy path.
		expect(fs.existsSync(lockDir)).toBe(false);
		const siblings = fs.readdirSync(tmpDir).filter((n) => n.includes(".lock"));
		expect(siblings).toEqual([]);
	});

	it("(b) leftover from a crash mid-break is acquirable by OLD semantics (plain mkdir)", () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		// Reproduce the on-disk state a crash between rename-aside and rmdir
		// leaves: the canonical lock path is ABSENT (renamed away) and an orphan
		// graveyard sibling lingers. An older version only knows <file>.lock.
		const orphanGraveyard = `${lockDir}.stale.99999.123456789.0`;
		fs.mkdirSync(orphanGraveyard);
		expect(fs.existsSync(lockDir)).toBe(false);

		// OLD acquire semantics: a plain, non-recursive mkdir of the canonical
		// path must succeed (the orphan sibling does not block it).
		expect(() => fs.mkdirSync(lockDir)).not.toThrow();
		expect(() => fs.rmdirSync(lockDir)).not.toThrow();

		// OLD stale-break semantics (plain stat-age + rmdir) likewise operate only
		// on the canonical path and are unaffected by the orphan sibling.
		expect(fs.existsSync(orphanGraveyard)).toBe(true);
	});

	it("(b) new code acquires fine despite an orphan graveyard sibling on disk", async () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		// Orphan left by a previous crash mid-break.
		fs.mkdirSync(`${lockDir}.stale.1.2.3`);

		const result = await withFileLock(filePath, async () => "ok");
		expect(result).toBe("ok");
		// Canonical lock released; the orphan is never mistaken for a lock.
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it("(b) while held by new code, the lock is a plain empty dir an OLD version can stat+rmdir", async () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		let oldStyleStatWorked = false;
		let oldStyleAgeFinite = false;
		await withFileLock(filePath, async () => {
			// Simulate what an OLD version sees/does: plain stat-age check + the
			// directory is empty (no new payload the old version can't handle).
			const st = fs.statSync(lockDir);
			oldStyleStatWorked = st.isDirectory();
			// The age computation an old version performs must yield a real number
			// (sign/jitter near zero is irrelevant — fresh locks aren't broken).
			oldStyleAgeFinite = Number.isFinite(Date.now() - st.mtimeMs);
			expect(fs.readdirSync(lockDir)).toEqual([]);
		});

		expect(oldStyleStatWorked).toBe(true);
		expect(oldStyleAgeFinite).toBe(true);
	});
});

describe("withFileLock — re-entrancy (same file, nested calls)", () => {
	it("does not deadlock on nested lock for the same file", async () => {
		const filePath = path.join(tmpDir, "test.json");

		// This tests that if the same async context tries to lock the same file
		// again (e.g. saveTasks calls loadTasks internally), it doesn't deadlock.
		// With mkdir-based locks, nested calls from the same "thread" will fail
		// because the lock is already held. This is expected — the API should
		// be used at the outermost boundary only.
		//
		// We document this behavior: nested withFileLock on the same file
		// will timeout/fail. Callers must structure code to avoid this.
		await expect(
			withFileLock(filePath, async () => {
				// Nested lock on same file — should timeout
				return withFileLock(filePath, async () => "inner", { timeout: 200 });
			}),
		).rejects.toThrow(FileLockTimeoutError);
	});
});
