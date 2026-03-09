import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
	it("executes the callback and returns its result", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const result = await withFileLock(filePath, async () => {
			return 42;
		});
		expect(result).toBe(42);
	});

	it("releases lock after successful execution", async () => {
		const filePath = path.join(tmpDir, "test.json");
		await withFileLock(filePath, async () => "done");

		// Lock directory should not exist after release
		const lockDir = filePath + ".lock";
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it("releases lock even if callback throws", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const lockDir = filePath + ".lock";

		await expect(
			withFileLock(filePath, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Lock must still be released
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it("propagates the callback error type", async () => {
		const filePath = path.join(tmpDir, "test.json");

		await expect(
			withFileLock(filePath, async () => {
				throw new TypeError("type mismatch");
			}),
		).rejects.toThrow(TypeError);
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

	it("second caller waits for first to finish", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const events: string[] = [];

		const op1 = withFileLock(filePath, async () => {
			events.push("op1-start");
			await new Promise((resolve) => setTimeout(resolve, 50));
			events.push("op1-end");
		});

		// Start op2 slightly after op1
		await new Promise((resolve) => setTimeout(resolve, 5));

		const op2 = withFileLock(filePath, async () => {
			events.push("op2-start");
			events.push("op2-end");
		});

		await Promise.all([op1, op2]);

		// op2 must start AFTER op1 ends (serialized)
		expect(events.indexOf("op1-end")).toBeLessThan(events.indexOf("op2-start"));
	});
});

describe("withFileLock — timeout", () => {
	it("throws FileLockTimeoutError when lock cannot be acquired in time", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const lockDir = filePath + ".lock";

		// Manually create lock directory to simulate a held lock
		fs.mkdirSync(lockDir);
		// Set mtime to now (not stale)
		const now = new Date();
		fs.utimesSync(lockDir, now, now);

		await expect(
			withFileLock(filePath, async () => "never", { timeout: 100, staleThreshold: 60000 }),
		).rejects.toThrow(FileLockTimeoutError);

		// Clean up
		fs.rmdirSync(lockDir);
	});
});

describe("withFileLock — stale lock recovery", () => {
	it("breaks a stale lock and acquires it", async () => {
		const filePath = path.join(tmpDir, "test.json");
		const lockDir = filePath + ".lock";

		// Create a stale lock (mtime in the past)
		fs.mkdirSync(lockDir);
		const pastTime = new Date(Date.now() - 30000); // 30 seconds ago
		fs.utimesSync(lockDir, pastTime, pastTime);

		const result = await withFileLock(
			filePath,
			async () => "recovered",
			{ staleThreshold: 5000 }, // consider stale after 5s
		);

		expect(result).toBe("recovered");
		// Lock should be released
		expect(fs.existsSync(lockDir)).toBe(false);
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
