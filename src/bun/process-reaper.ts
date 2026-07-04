import { spawn } from "./spawn";

/**
 * Injectable primitives so the terminate/wait logic is unit-testable without
 * spawning real processes. Production code uses {@link defaultReaperDeps}.
 */
export interface ReaperDeps {
	/** `process.kill` semantics: signal 0 probes liveness, throws ESRCH when gone. */
	kill(pid: number, signal: NodeJS.Signals | 0): void;
	sleep(ms: number): Promise<void>;
}

export const defaultReaperDeps: ReaperDeps = {
	kill(pid: number, signal: NodeJS.Signals | 0): void {
		process.kill(pid, signal);
	},
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	},
};

export function isPidAlive(pid: number, deps: ReaperDeps = defaultReaperDeps): boolean {
	try {
		deps.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function signalPids(pids: number[], signal: NodeJS.Signals, deps: ReaperDeps = defaultReaperDeps): void {
	for (const pid of pids) {
		try {
			deps.kill(pid, signal);
		} catch {
			// Process already gone or not permitted — best-effort reaping.
		}
	}
}

/**
 * Poll until every PID has exited or `timeoutMs` elapses.
 * Returns the PIDs still alive at the end (empty array = all gone).
 */
export async function waitForPidsGone(
	pids: number[],
	timeoutMs: number,
	pollMs: number,
	deps: ReaperDeps = defaultReaperDeps,
): Promise<number[]> {
	let alive = pids.filter((pid) => isPidAlive(pid, deps));
	for (let waited = 0; alive.length > 0 && waited < timeoutMs; waited += pollMs) {
		await deps.sleep(pollMs);
		alive = alive.filter((pid) => isPidAlive(pid, deps));
	}
	return alive;
}

/**
 * Verified terminate: SIGTERM everything, poll until the PIDs actually exit
 * (early-exit, bounded by `termGraceMs`), SIGKILL the survivors, then poll
 * again bounded by `killWaitMs`. Returns the PIDs that are STILL alive after
 * all of that — an empty array means the teardown is confirmed complete, not
 * merely requested. Callers must treat a non-empty result as a failure signal
 * (log it, don't report success upstream as if everything died).
 */
export async function terminatePidsVerified(
	pids: number[],
	opts: { termGraceMs?: number; killWaitMs?: number; pollMs?: number } = {},
	deps: ReaperDeps = defaultReaperDeps,
): Promise<number[]> {
	if (pids.length === 0) return [];
	const termGraceMs = opts.termGraceMs ?? 1500;
	const killWaitMs = opts.killWaitMs ?? 2000;
	const pollMs = opts.pollMs ?? 100;

	signalPids(pids, "SIGTERM", deps);
	const survivors = await waitForPidsGone(pids, termGraceMs, pollMs, deps);
	if (survivors.length === 0) return [];

	signalPids(survivors, "SIGKILL", deps);
	return waitForPidsGone(survivors, killWaitMs, pollMs, deps);
}

/**
 * Current working directory of a live process, via `lsof -d cwd`.
 *
 * `lsof` is the one process-inspection tool proven to work from the packaged
 * GUI `.app` (port scanning relies on it); `ps -E` / `pgrep` sysctls are
 * blocked for other PIDs under the hardened runtime (see decision 095), so
 * env-marker matching is NOT a viable ownership check there. Returns null
 * when the cwd cannot be read. Note lsof resolves symlinks (`/tmp` →
 * `/private/tmp`), so compare against a realpath'd reference.
 */
export async function getPidCwd(pid: number): Promise<string | null> {
	try {
		const proc = spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { stdout: "pipe", stderr: "pipe" });
		const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return null;
		for (const line of output.split("\n")) {
			if (line.startsWith("n")) {
				const cwd = line.slice(1).trim();
				return cwd || null;
			}
		}
		return null;
	} catch {
		return null;
	}
}
