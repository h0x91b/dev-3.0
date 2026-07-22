/**
 * Impure half of process-identity: reads a live process's POSIX start time.
 * Isolated from the pure module so unit tests never pull in Bun.spawn.
 */

import { spawnSync } from "../spawn";
import { formatStartSignature } from "./process-identity";

/**
 * Read a stable start signature for `pid` via `ps -p PID -o lstart=`, or "" when
 * the process is gone / `ps` is unavailable. Never throws. POSIX only — Windows
 * ownership is proven through the Job Object, not a start signature.
 */
export function readProcessStartSignature(pid: number): string {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	if (process.platform === "win32") return "";
	try {
		const res = spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
		if (!res.success) return "";
		const raw = new TextDecoder().decode(res.stdout).trim();
		return formatStartSignature(pid, raw);
	} catch {
		return "";
	}
}
