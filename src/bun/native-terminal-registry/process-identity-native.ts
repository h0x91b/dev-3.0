/**
 * Impure half of process-identity: reads a live process's POSIX start time.
 * Isolated from the pure module so unit tests never pull in Bun.spawn.
 */

import { spawn } from "../spawn";
import { formatStartSignature } from "./process-identity";

/**
 * Read a stable start signature for `pid` via `ps -p PID -o lstart=`, or "" when
 * the process is gone / `ps` is unavailable. Never throws. POSIX only — Windows
 * ownership is proven through the Job Object, not a start signature.
 *
 * Async on purpose: a whole pane set is classified per pane action, and a
 * synchronous `ps` blocks the event loop, so N probes cost N × fork no matter how
 * they are scheduled (seq 1382).
 */
export async function readProcessStartSignature(pid: number): Promise<string> {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	if (process.platform === "win32") return "";
	try {
		const proc = spawn(["ps", "-p", String(pid), "-o", "lstart="], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [raw, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return "";
		return formatStartSignature(pid, raw.trim());
	} catch {
		return "";
	}
}
