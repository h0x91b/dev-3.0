import * as fs from "node:fs";
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

function tryBreakStaleLock(lockDir: string, staleThreshold: number): boolean {
	try {
		const stat = fs.statSync(lockDir);
		const age = Date.now() - stat.mtimeMs;
		if (age > staleThreshold) {
			log.warn("Breaking stale lock", { lockDir, ageMs: age });
			fs.rmdirSync(lockDir);
			return true;
		}
	} catch {
		// Lock disappeared between check and stat — that's fine, next mkdir will succeed
		return true;
	}
	return false;
}

function releaseLock(lockDir: string): void {
	try {
		fs.rmdirSync(lockDir);
	} catch (err: any) {
		// Lock already gone (shouldn't happen, but don't crash)
		log.warn("Lock already released", { lockDir, error: String(err) });
	}
}
