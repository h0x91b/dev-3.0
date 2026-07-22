/**
 * Process liveness + identity for the native-session registry (seq 1214).
 *
 * A bare PID is not enough to prove ownership: after a host dies the OS reuses
 * its PID, so a stale record could point at an unrelated live process. On POSIX
 * we pin the recorded host/shell to their absolute start time (`ps -o lstart`),
 * yielding a signature that a reused PID cannot forge. On Windows the token-named
 * Job Object membership is the ownership proof (see windows-job.ts), so the
 * signature is left empty there.
 *
 * This module keeps the PURE, unit-testable pieces (validation, signature
 * formatting/matching) free of any Bun/child_process import; the impure reader
 * that shells out to `ps` lives in process-identity-native.ts.
 */

/**
 * Is `pid` a live process? `kill(pid, 0)` sends no signal — it only probes.
 * ESRCH ⇒ dead. EPERM ⇒ exists but owned by another user (alive).
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Build a start signature from a PID and the raw `ps -o lstart=` output.
 * Whitespace is normalised so cosmetic `ps` formatting differences do not make
 * a genuinely-identical process look reused. Returns "" for unusable input.
 */
export function formatStartSignature(pid: number, rawStart: string): string {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	const normalized = rawStart.trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	return `${pid}@${normalized}`;
}

/**
 * Two POSIX start signatures identify the same process only when both are
 * non-empty and byte-identical. An empty recorded signature never matches — a
 * record without ownership evidence must not be treated as owned.
 */
export function startSignaturesMatch(recorded: string, current: string): boolean {
	if (!recorded || !current) return false;
	return recorded === current;
}
