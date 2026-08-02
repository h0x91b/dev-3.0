/**
 * Impure half of process-identity: reads a live process's POSIX start time.
 * Isolated from the pure module so unit tests never pull in Bun.spawn.
 */

import { spawn } from "../spawn";
import { formatStartSignature, parseStartSignatures } from "./process-identity";

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

/**
 * Start signatures for a whole pane-set sweep in ONE `ps`, keyed by pid. Every
 * pid is asked for once; a pid that is missing from the answer is absent from
 * the map, which reads as "unverifiable" downstream — exactly what the per-pid
 * probe returns for the same process (seq 1388).
 *
 * The exit code is deliberately not a gate: `ps` reports non-zero when ANY
 * requested pid is gone, and discarding the whole batch for one dead pid would
 * un-verify its live siblings and reconcile them out of the layout.
 */
export async function readProcessStartSignatures(pids: readonly number[]): Promise<Map<number, string>> {
	const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
	if (wanted.length === 0 || process.platform === "win32") return new Map();
	try {
		const proc = spawn(["ps", "-p", wanted.join(","), "-o", "pid=,lstart="], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [raw] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return parseStartSignatures(wanted, raw);
	} catch {
		return new Map();
	}
}
