/**
 * Delete a test's temp tree, tolerating Windows releasing file handles late.
 *
 * On windows-latest a directory can stay locked for a moment after every process in it has
 * exited (Defender scanning a freshly copied .exe), and `rmSync` throws EBUSY — failing an E2E
 * whose checks all passed (7 red Canary runs). Bun documents no `maxRetries` for `rmSync`, so the
 * retry is explicit. A lock outlasting the budget still throws: a leaked process must surface.
 */

import { rmSync } from "node:fs";

const TRANSIENT = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export interface RemoveTempTreeOptions {
	attempts?: number;
	delayMs?: number;
	rm?: (path: string) => void;
	sleep?: (ms: number) => void;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempTree(path: string, options: RemoveTempTreeOptions = {}): void {
	const {
		attempts = 20,
		delayMs = 250,
		rm = (target) => rmSync(target, { recursive: true, force: true }),
		sleep = sleepSync,
	} = options;
	for (let attempt = 1; ; attempt += 1) {
		try {
			rm(path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!code || !TRANSIENT.has(code) || attempt >= attempts) throw error;
			sleep(delayMs);
		}
	}
}
