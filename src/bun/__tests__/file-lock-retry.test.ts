import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { withFileLock, FileLockTimeoutError } from "../file-lock";

// A lost 5-second acquisition window under real contention used to fail the
// whole operation (e.g. `dev3 note add`). withFileLock now retries a timed-out
// acquisition a bounded number of times, keeping the per-attempt deadline short.
const tempDir = mkdtempSync(join(tmpdir(), "dev3-lock-retry-"));
const filePath = join(tempDir, "tasks.json");
const lockDir = `${filePath}.lock`;

describe("withFileLock — bounded acquisition retry", () => {
	beforeEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("acquires the lock on a later attempt when the holder releases late", async () => {
		mkdirSync(lockDir);
		setTimeout(() => rmdirSync(lockDir), 120);

		const result = await withFileLock(filePath, async () => "acquired", {
			timeout: 50,
			staleThreshold: 60000,
		});

		expect(result).toBe("acquired");
	});

	it("reports the attempt count once every attempt times out", async () => {
		mkdirSync(lockDir);

		await expect(
			withFileLock(filePath, async () => "never", { timeout: 30, staleThreshold: 60000 }),
		).rejects.toThrow(/\(3 attempts\)/);
	});

	it("fails on the first timeout when retries are disabled", async () => {
		mkdirSync(lockDir);

		const started = Date.now();
		const err = await withFileLock(filePath, async () => "never", {
			timeout: 30,
			staleThreshold: 60000,
			retries: 0,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(FileLockTimeoutError);
		expect(String(err.message)).not.toContain("attempts");
		expect(Date.now() - started).toBeLessThan(300);
	});
});
