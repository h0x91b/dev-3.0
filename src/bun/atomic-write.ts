import { rename, unlink, writeFile } from "node:fs/promises";
import { createLogger } from "./logger";

const log = createLogger("atomic-write");

// Per-call counter: the temp name must be unique per CALL, not per process.
// Two concurrent atomicWriteFile calls to the same file inside one process used
// to share `<file>.tmp-<pid>`, so the loser's rename() hit ENOENT and its
// cleanup unlink() could delete the winner's temp file mid-flight.
let atomicWriteSeq = 0;

// Backoff for a transient failure of the write/rename pair (a Windows indexer
// or antivirus holding the file, a momentary EACCES). Bounded on purpose — a
// real permission or disk problem must still surface.
const ATOMIC_WRITE_RETRY_DELAYS_MS = [10, 30, 90];
const TRANSIENT_WRITE_ERROR_CODES = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);

/**
 * Crash-safe write: write `content` to a sibling temp file in the SAME
 * directory, then rename() it over `filePath`. rename() within one filesystem
 * is atomic on POSIX, so a crash/power-loss can only ever leave the temp file
 * truncated — never the live file. The temp name (`<file>.tmp-<pid>-<n>`) never
 * matches the exact filenames or backup patterns older versions read, so a
 * leftover is harmless; we still clean it up on failure. The final path and
 * byte content are identical to the old in-place writeFile, so older app
 * versions read/write these files unchanged.
 *
 * Lives in its own module so every data-layer sibling (data.ts,
 * automations-data.ts, task-blobs.ts) can use it without importing each other.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		const tmpPath = `${filePath}.tmp-${process.pid}-${atomicWriteSeq++}`;
		try {
			await writeFile(tmpPath, content);
			await rename(tmpPath, filePath);
			return;
		} catch (err: any) {
			await unlink(tmpPath).catch(() => {});
			const retryable = TRANSIENT_WRITE_ERROR_CODES.has(err?.code);
			if (!retryable || attempt >= ATOMIC_WRITE_RETRY_DELAYS_MS.length) throw err;
			const delay = ATOMIC_WRITE_RETRY_DELAYS_MS[attempt];
			log.warn("Atomic write failed, retrying", { filePath, code: err.code, attempt: attempt + 1, delay });
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}
