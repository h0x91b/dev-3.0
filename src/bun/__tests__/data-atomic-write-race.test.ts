import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";

// The temp-path and rename behaviour of atomicWriteFile is what the two vents
// about transient task-metadata failures come down to, so the fs layer is
// mocked only to (a) observe every temp path it picks and (b) inject a single
// transient rename failure. Everything else runs against the real filesystem.
const writtenTempPaths: string[] = [];
let renameFailures: Array<string | null> = [];

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return {
		...actual,
		writeFile: vi.fn(async (path: any, data: any, opts?: any) => {
			writtenTempPaths.push(String(path));
			return actual.writeFile(path, data, opts);
		}),
		rename: vi.fn(async (from: any, to: any) => {
			const code = renameFailures.shift();
			if (code) {
				const err: NodeJS.ErrnoException = new Error(`simulated ${code}`);
				err.code = code;
				throw err;
			}
			return actual.rename(from, to);
		}),
	};
});

const tempDir = mkdtempSync(join(tmpdir(), "dev3-atomic-race-"));
const targetFile = join(tempDir, "tasks.json");

function tempSiblings(): string[] {
	return readdirSync(tempDir).filter((f) => f.includes(".tmp"));
}

describe("atomicWriteFile — concurrency and transient failures", () => {
	beforeEach(() => {
		writtenTempPaths.length = 0;
		renameFailures = [];
		rmSync(tempDir, { recursive: true, force: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		renameFailures = [];
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("gives every call its own temp path", async () => {
		const { atomicWriteFile } = await import("../atomic-write");

		await atomicWriteFile(targetFile, "one");
		await atomicWriteFile(targetFile, "two");

		expect(writtenTempPaths).toHaveLength(2);
		expect(new Set(writtenTempPaths).size).toBe(2);
		for (const p of writtenTempPaths) expect(p.startsWith(`${targetFile}.tmp-`)).toBe(true);
	});

	it("survives concurrent writes to the same file inside one process", async () => {
		const { atomicWriteFile } = await import("../atomic-write");

		const payloads = ["a", "bb", "ccc", "dddd", "eeeee"];
		// Before the per-call temp suffix, the losers of this race hit ENOENT on
		// rename (their temp file was renamed away by the winner) and rejected.
		await Promise.all(payloads.map((p) => atomicWriteFile(targetFile, p)));

		expect(payloads).toContain(readFileSync(targetFile, "utf8"));
		expect(tempSiblings()).toHaveLength(0);
	});

	it("retries a transient rename failure and then lands the write", async () => {
		const { atomicWriteFile } = await import("../atomic-write");

		renameFailures = ["EPERM", "EBUSY"];
		await atomicWriteFile(targetFile, "landed");

		expect(readFileSync(targetFile, "utf8")).toBe("landed");
		expect(writtenTempPaths).toHaveLength(3);
		expect(tempSiblings()).toHaveLength(0);
	});

	it("surfaces a non-transient error immediately instead of retrying", async () => {
		const { atomicWriteFile } = await import("../atomic-write");

		renameFailures = ["EXDEV"];
		await expect(atomicWriteFile(targetFile, "nope")).rejects.toThrow("simulated EXDEV");

		expect(writtenTempPaths).toHaveLength(1);
		expect(tempSiblings()).toHaveLength(0);
	});

	it("gives up after the bounded retry budget", async () => {
		const { atomicWriteFile } = await import("../atomic-write");

		renameFailures = ["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"];
		await expect(atomicWriteFile(targetFile, "nope")).rejects.toThrow("simulated EBUSY");

		expect(writtenTempPaths).toHaveLength(4);
		expect(tempSiblings()).toHaveLength(0);
	});
});
