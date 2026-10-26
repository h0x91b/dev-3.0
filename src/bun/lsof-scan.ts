/**
 * Every whole-system `lsof` scan dev3 runs goes through here, bounded.
 *
 * A full `lsof` walks every fd of every process; on a loaded Mac it took 70-150 s
 * instead of well under one, and an unbounded wait let scans pile up behind each
 * other. Measurements and the leak it fed: decisions/2026/10/26/bound-lsof-scans.md.
 *
 * `lsof` forks a helper child that survives a TERM to its parent, so the scan runs
 * in its own process group and a stop signals the whole group.
 */
import { spawn } from "./spawn";
import { createLogger } from "./logger";
import { runBounded } from "./tmux/bounded-spawn";

const log = createLogger("lsof-scan");

/** A healthy LISTEN scan takes well under a second; past this it is stuck behind the kernel. */
export const LISTEN_SCAN_TIMEOUT_MS = 20_000;
/** The cwd scan covers every process (not only sockets), and a teardown can afford to wait longer. */
export const CWD_SCAN_TIMEOUT_MS = 30_000;

export interface LsofResult {
	stdout: string;
	exitCode: number;
}

/**
 * Run `lsof args`, or null when it was not measured: the spawn failed, it timed
 * out and was stopped, or `signal` aborted it. Settles only after a stopped
 * scan's process group has been signalled and its leader reaped.
 */
export async function runLsof(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<LsofResult | null> {
	const cmd = ["lsof", ...args];
	const processGroup = process.platform !== "win32";
	let outcome: Awaited<ReturnType<typeof runBounded>>;
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe", detached: processGroup });
		outcome = await runBounded(proc, { timeoutMs, signal, processGroup });
	} catch {
		return null;
	}
	if (outcome.kind === "stopped") {
		if (!signal?.aborted) log.warn("lsof scan timed out and was stopped", { args: args.join(" "), timeoutMs, confirmed: outcome.confirmed });
		return null;
	}
	return { stdout: outcome.value.stdout, exitCode: outcome.value.exitCode };
}
