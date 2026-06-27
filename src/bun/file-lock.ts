import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "./logger";

const log = createLogger("file-lock");

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_STALE_THRESHOLD = 10000;
const INITIAL_RETRY_DELAY = 5;
const MAX_RETRY_DELAY = 50;

export class FileLockTimeoutError extends Error {
	constructor(lockPath: string, timeout: number) {
		super(`Failed to acquire file lock "${lockPath}" within ${timeout}ms`);
		this.name = "FileLockTimeoutError";
	}
}

export interface FileLockOptions {
	timeout?: number;
	staleThreshold?: number;
}

/**
 * Execute `fn` while holding an exclusive mkdir-based lock on `filePath`.
 *
 * The lock is a directory (`filePath + ".lock"`). `mkdir` is atomic on POSIX
 * and NTFS — if the directory already exists, it fails with EEXIST, which we
 * use as a spinlock signal.
 *
 * Guarantees:
 * - Only one caller (across threads and processes) executes `fn` at a time
 *   for the same `filePath`.
 * - The lock is always released (via `finally`), even if `fn` throws.
 * - Stale locks (from crashed processes) are auto-broken after `staleThreshold`.
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
	const staleThreshold = options?.staleThreshold ?? DEFAULT_STALE_THRESHOLD;
	const lockDir = filePath + ".lock";

	await acquireLock(lockDir, timeout, staleThreshold);
	try {
		return await fn();
	} finally {
		releaseLock(lockDir);
	}
}

async function acquireLock(
	lockDir: string,
	timeout: number,
	staleThreshold: number,
): Promise<void> {
	const deadline = Date.now() + timeout;
	let delay = INITIAL_RETRY_DELAY;

	while (true) {
		try {
			fs.mkdirSync(lockDir);
			return; // Lock acquired
		} catch (err: any) {
			if (err.code === "ENOENT") {
				// Parent directory doesn't exist (e.g. new project with no tasks yet).
				// Create ONLY the parent recursively, then loop back to retry the
				// plain (non-recursive) mkdir of the lock dir itself. Calling
				// mkdirSync(lockDir, { recursive: true }) directly would swallow
				// EEXIST, so two processes racing through this branch would both
				// believe they acquired the lock.
				fs.mkdirSync(path.dirname(lockDir), { recursive: true });
				continue; // Parent ready — retry the atomic lock-dir mkdir
			}
			if (err.code !== "EEXIST") {
				throw err; // Unexpected error (e.g. permissions)
			}
		}

		// Lock exists — check if it's stale
		if (tryBreakStaleLock(lockDir, staleThreshold)) {
			continue; // Stale lock broken, retry immediately
		}

		// Check timeout
		if (Date.now() >= deadline) {
			throw new FileLockTimeoutError(lockDir, timeout);
		}

		// Wait with exponential backoff + jitter
		const jitter = Math.random() * delay * 0.5;
		await new Promise((resolve) => setTimeout(resolve, delay + jitter));
		delay = Math.min(delay * 2, MAX_RETRY_DELAY);
	}
}

// Monotonic per-process counter ensuring every stale-break attempt picks a
// unique graveyard path, even for back-to-back breaks within one process.
let staleBreakSeq = 0;

/**
 * Attempt to break a (suspected) stale lock at `lockDir`.
 *
 * Returns `true` if the caller should retry `mkdir` immediately (the lock is
 * gone or was just broken), `false` if the lock is fresh and must be waited on.
 * Throws on unexpected filesystem errors (e.g. EACCES) so the caller surfaces
 * the real problem instead of spinning in an endless break-retry loop.
 *
 * TOCTOU safety: we must NOT `rmdir(lockDir)` directly after a separate `stat`.
 * Between the two, another breaker may have already broken the stale lock and
 * acquired a FRESH one at the same path (an ABA race). A blind `rmdir` would
 * then delete that live lock, letting two holders run their critical sections
 * concurrently and corrupt the file. Instead we:
 *   1. `stat` to decide staleness (fresh → leave it alone).
 *   2. Atomically `rename` the suspected-stale dir aside to a unique graveyard.
 *      `rename` is atomic, so only ONE breaker can move a given dir; concurrent
 *      breakers get ENOENT and fall back to a clean `mkdir` race.
 *   3. Re-validate the age on the now-isolated graveyard. If it turns out to be
 *      FRESH, we grabbed a live lock (ABA) — restore it and do not break.
 *   4. Otherwise remove the graveyard; the canonical lock path is now free.
 *
 * On-disk compatibility: the canonical lock stays a plain `<file>.lock`
 * directory created via `mkdir` — an older app version sharing ~/.dev3.0/ can
 * still acquire/release/stale-break it. The graveyard is a transient sibling at
 * `<file>.lock.stale.*`; older versions never look there, and after a crash
 * mid-break the canonical path is simply absent (acquirable by plain `mkdir`).
 */
function tryBreakStaleLock(lockDir: string, staleThreshold: number): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(lockDir);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			// Lock disappeared between EEXIST and stat — fine, next mkdir will win.
			return true;
		}
		// EACCES / EPERM / etc. — a real problem. Surface it instead of looping
		// forever (a bare `return true` here causes an endless break-retry spin).
		throw err;
	}

	if (Date.now() - stat.mtimeMs <= staleThreshold) {
		// Fresh lock held by someone else — leave it alone.
		return false;
	}

	// Looks stale. Atomically claim it by renaming aside to a unique graveyard.
	const graveyard = `${lockDir}.stale.${process.pid}.${Date.now()}.${staleBreakSeq++}`;
	try {
		fs.renameSync(lockDir, graveyard);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			// Another breaker already claimed/removed it — retry mkdir.
			return true;
		}
		throw err;
	}

	// Re-validate on the isolated copy. If it is actually fresh, another process
	// re-acquired the lock between our stat and our rename (ABA) — we just moved
	// a LIVE lock. Restore it to its rightful holder and do not break.
	try {
		const claimed = fs.statSync(graveyard);
		if (Date.now() - claimed.mtimeMs <= staleThreshold) {
			try {
				fs.renameSync(graveyard, lockDir);
			} catch {
				// The canonical path was re-taken in a 3-way race; we cannot safely
				// restore. Leaving the graveyard in place is the least-bad option —
				// it never sits at the canonical lock path, so neither old nor new
				// versions treat it as a lock. Do NOT rmdir it; it may be live.
				log.warn("Stale-lock restore failed; leaving claimed dir aside", {
					lockDir,
					graveyard,
				});
			}
			return false;
		}
	} catch (err: any) {
		// We just renamed INTO the graveyard, so ENOENT is not expected here.
		// Tolerate it; for any other error fall through to best-effort removal.
		if (err.code !== "ENOENT") {
			log.warn("Stale-lock re-validation failed", {
				graveyard,
				error: String(err),
			});
		}
	}

	// Confirmed stale and isolated — remove it. The canonical path is now free.
	log.warn("Breaking stale lock", {
		lockDir,
		ageMs: Date.now() - stat.mtimeMs,
	});
	try {
		fs.rmdirSync(graveyard);
	} catch (err: any) {
		// Best effort: even if removal fails, the canonical lock path is free.
		log.warn("Failed to remove claimed stale lock", {
			graveyard,
			error: String(err),
		});
	}
	return true;
}

function releaseLock(lockDir: string): void {
	try {
		fs.rmdirSync(lockDir);
	} catch (err: any) {
		// Lock already gone (shouldn't happen, but don't crash)
		log.warn("Lock already released", { lockDir, error: String(err) });
	}
}
