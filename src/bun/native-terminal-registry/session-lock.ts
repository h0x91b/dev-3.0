/**
 * The cross-process lock serializing everything that mutates one session's owned
 * state: token, record and capture artifacts.
 *
 * It fails CLOSED. Running a critical section without the lock is worse than not
 * running it: an unlocked cleanup can delete a successor's artifacts, which is the
 * interleaving this exists to prevent.
 *
 * Lock ordering: this is the INNERMOST lock. Nothing inside it may take another.
 */

import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { sessionLockFile, sessionLocksRootDir } from "./paths";

/** A lock older than this belonged to a process that died before releasing it. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 5;

export class SessionLockTimeoutError extends Error {
	constructor(readonly sessionId: string) {
		super(`could not acquire the state lock for session ${sessionId} within ${LOCK_WAIT_MS}ms`);
		this.name = "SessionLockTimeoutError";
	}
}

function spin(ms: number): void {
	// Synchronous by necessity: the callers (host publish, teardown) are synchronous,
	// and every critical section is a handful of file operations.
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// waiting
	}
}

/**
 * Run `fn` while HOLDING the lock, or throw {@link SessionLockTimeoutError}. Never
 * runs `fn` unlocked. A stale lock is broken so a dead holder cannot wedge the
 * session, while a live holder is never stolen from.
 */
export function withSessionStateLock<T>(sessionId: string, fn: () => T): T {
	const lock = sessionLockFile(sessionId, "canonical");
	mkdirSync(sessionLocksRootDir(), { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(lock, "wx");
			try {
				writeSync(fd, `${process.pid}\n`);
			} finally {
				closeSync(fd);
			}
			break;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
			} catch {
				// vanished between stat and unlink; retry the acquire
			}
			if (Date.now() >= deadline) throw new SessionLockTimeoutError(sessionId);
			spin(LOCK_POLL_MS);
		}
	}
	try {
		return fn();
	} finally {
		try {
			if (existsSync(lock)) unlinkSync(lock);
		} catch {
			// already removed
		}
	}
}
