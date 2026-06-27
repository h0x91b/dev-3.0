import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// Shared control object — lets a test inject a single, deterministic
// cross-process interleaving into the otherwise-real filesystem.
const control = vi.hoisted(() => ({
	// ABA injection: on the FIRST statSync of `watchPath`, simulate ANOTHER
	// process that breaks the stale lock and acquires a fresh one — all between
	// THIS process's staleness check and its subsequent destructive op.
	abaArm: false,
	abaDone: false,
	// EACCES injection: every statSync of `watchPath` throws EACCES.
	eaccesArm: false,
	watchPath: "",
}));

// Mock node:fs but delegate everything to the real implementation, except for
// `statSync`, which we wrap to inject the controlled interleaving / error.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: (p: unknown, opts?: unknown) => {
			const ps = String(p);
			if (control.eaccesArm && ps === control.watchPath) {
				const e = new Error("EACCES: permission denied, stat") as NodeJS.ErrnoException;
				e.code = "EACCES";
				throw e;
			}
			// Capture the real (pre-injection) stat first — this is the OLD, stale
			// snapshot that the caller will reason about.
			const result = (actual.statSync as (p: unknown, opts?: unknown) => fsStats)(p, opts);
			if (control.abaArm && !control.abaDone && ps === control.watchPath) {
				control.abaDone = true;
				// Simulate "process A": break the stale lock and acquire a FRESH one,
				// entering its critical section. The caller (process B) still gets the
				// OLD stale snapshot returned below, so it believes the lock is stale.
				actual.rmdirSync(control.watchPath);
				actual.mkdirSync(control.watchPath);
				const now = new Date();
				actual.utimesSync(control.watchPath, now, now);
			}
			return result;
		},
	};
});

type fsStats = import("node:fs").Stats;

import * as fs from "node:fs";
import { withFileLock, FileLockTimeoutError } from "../file-lock";

let tmpDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	control.abaArm = false;
	control.abaDone = false;
	control.eaccesArm = false;
	control.watchPath = "";
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-toctou-"));
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	control.abaArm = false;
	control.abaDone = false;
	control.eaccesArm = false;
	control.watchPath = "";
	warnSpy.mockRestore();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withFileLock — stale-lock break TOCTOU (cross-process)", () => {
	it("does not break a lock that another process freshly re-acquired mid-break", async () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		// A stale lock exists on disk (created the old way: plain mkdir + old mtime).
		fs.mkdirSync(lockDir);
		const past = new Date(Date.now() - 30000); // 30s ago
		fs.utimesSync(lockDir, past, past);

		// Arm the ABA interleaving: when THIS process checks staleness, another
		// process breaks the stale lock and acquires a FRESH one before this
		// process performs its own destructive removal.
		control.watchPath = lockDir;
		control.abaArm = true;

		let fnRan = false;
		// Buggy code: this process blindly rmdir's whatever is at lockDir (now the
		// OTHER process's fresh lock) and acquires it → both run concurrently.
		// Fixed code: it detects the lock is now fresh, leaves it, and times out.
		await expect(
			withFileLock(
				filePath,
				async () => {
					fnRan = true;
					return "acquired";
				},
				{ timeout: 300, staleThreshold: 10000 },
			),
		).rejects.toThrow(FileLockTimeoutError);

		// This process must NOT have entered the critical section.
		expect(fnRan).toBe(false);
		// The other process's fresh lock must still be intact (not stolen).
		expect(fs.existsSync(lockDir)).toBe(true);

		fs.rmdirSync(lockDir);
	});

	it("surfaces a non-ENOENT stat error instead of spinning until timeout", async () => {
		const filePath = path.join(tmpDir, "tasks.json");
		const lockDir = filePath + ".lock";

		// A lock exists, so mkdir reports EEXIST and we reach the staleness check.
		fs.mkdirSync(lockDir);
		const now = new Date();
		fs.utimesSync(lockDir, now, now);

		// Every staleness stat fails with EACCES (e.g. a permissions problem).
		control.watchPath = lockDir;
		control.eaccesArm = true;

		// Buggy code: the bare catch returns true on ANY stat error → endless
		// break-retry loop until the deadline (FileLockTimeoutError). Fixed code:
		// the EACCES is propagated immediately.
		await expect(
			withFileLock(filePath, async () => "never", { timeout: 1000, staleThreshold: 60000 }),
		).rejects.toThrow(/EACCES/);

		control.eaccesArm = false;
		fs.rmdirSync(lockDir);
	});
});
