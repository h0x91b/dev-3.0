import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// Shared control object — toggled by the test to inject a single, deterministic
// cross-process interleaving into the otherwise-real filesystem.
const control = vi.hoisted(() => ({
	interceptFirstPlainMkdir: false,
	firstPlainDone: false,
}));

// Mock node:fs but delegate everything to the real implementation, except for
// `mkdirSync`: when armed, the FIRST non-recursive call throws ENOENT. This
// reproduces the cross-process race where this process checked the parent dir
// before another process created it, while the lock dir actually already exists
// on disk (held by that other process).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (p: unknown, opts?: unknown) => {
			const recursive = !!(opts && typeof opts === "object" && (opts as { recursive?: boolean }).recursive);
			if (control.interceptFirstPlainMkdir && !recursive && !control.firstPlainDone) {
				control.firstPlainDone = true;
				const e = new Error("ENOENT: simulated cross-process race") as NodeJS.ErrnoException;
				e.code = "ENOENT";
				throw e;
			}
			return (actual.mkdirSync as (p: unknown, opts?: unknown) => unknown)(p, opts);
		},
	};
});

import * as fs from "node:fs";
import { withFileLock, FileLockTimeoutError } from "../file-lock";

let tmpDir: string;

beforeEach(() => {
	control.interceptFirstPlainMkdir = false;
	control.firstPlainDone = false;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-race-"));
});

afterEach(() => {
	control.interceptFirstPlainMkdir = false;
	control.firstPlainDone = false;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withFileLock — ENOENT branch must not double-acquire (cross-process)", () => {
	it("does not steal a lock already held by another process when the first mkdir reports ENOENT", async () => {
		const filePath = path.join(tmpDir, "new-project", "tasks.json");
		const lockDir = filePath + ".lock";

		// Another process already holds the lock: the lock dir (and its parent)
		// exist on disk with a fresh (non-stale) mtime.
		fs.mkdirSync(lockDir, { recursive: true });
		const now = new Date();
		fs.utimesSync(lockDir, now, now);

		// Arm the interception: this process's first non-recursive mkdir of the
		// lock dir observes ENOENT, driving it into the ENOENT recovery branch.
		control.interceptFirstPlainMkdir = true;
		control.firstPlainDone = false;

		let fnRan = false;
		// Buggy code: the recursive fallback silently "succeeds" on the
		// already-existing lock dir → fn runs (double acquire). Fixed code: only
		// creates the parent, retries a plain mkdir → EEXIST → eventual timeout.
		await expect(
			withFileLock(
				filePath,
				async () => {
					fnRan = true;
					return "acquired";
				},
				{ timeout: 200, staleThreshold: 60000 },
			),
		).rejects.toThrow(FileLockTimeoutError);

		expect(fnRan).toBe(false);
		// The other process's lock dir must remain intact (not stolen/removed).
		expect(fs.existsSync(lockDir)).toBe(true);

		fs.rmdirSync(lockDir);
	});
});
