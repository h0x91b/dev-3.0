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
 * Parse one batched `ps -p <csv> -o pid=,lstart=` output into signatures, in the
 * exact same format {@link formatStartSignature} produces for a single pid.
 *
 * FAIL CLOSED PER PID: only a line that parses cleanly AND was actually asked
 * for yields a signature. `ps` prints rows pid-sorted rather than in request
 * order, omits pids that are gone, and exits non-zero when none matched — so
 * absence is the signal that matters and an unusable line simply leaves its pid
 * out. Rows that disagree about one pid drop it entirely: no pid may inherit
 * another pid's evidence.
 */
export function parseStartSignatures(requested: readonly number[], raw: string): Map<number, string> {
	const wanted = new Set(requested.filter((pid) => Number.isInteger(pid) && pid > 0));
	const signatures = new Map<number, string>();
	const ambiguous = new Set<number>();
	for (const line of raw.split("\n")) {
		const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!wanted.has(pid) || ambiguous.has(pid)) continue;
		const signature = formatStartSignature(pid, match[2]!);
		if (!signature) continue;
		const seen = signatures.get(pid);
		if (seen === undefined) {
			signatures.set(pid, signature);
		} else if (seen !== signature) {
			signatures.delete(pid);
			ambiguous.add(pid);
		}
	}
	return signatures;
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
