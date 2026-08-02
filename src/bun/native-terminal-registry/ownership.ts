/**
 * Ownership verification for the native-session registry (seq 1214).
 *
 * Decides whether a recorded session is genuinely alive AND still ours, using
 * ONLY passive probes — it never opens the transport and never signals a PID.
 * This is what lets `list`/`status`/`cleanup` reject a stale record whose PID
 * has been reused by an unrelated process:
 *   • POSIX  — the recorded host/shell start signature must still match the
 *     live process's `ps -o lstart` (a reused PID has a newer start time).
 *   • Windows — the recorded host/shell PIDs must still be members of the
 *     session's token-named Job Object.
 *
 * The probes are injectable so every verdict is deterministically unit-testable
 * without real processes; the real POSIX `ps` / Windows Job calls only run in
 * the lifecycle E2E.
 */

import { isProcessAlive, startSignaturesMatch } from "./process-identity";
import { readProcessStartSignature, readProcessStartSignatures } from "./process-identity-native";
import type { NativeSessionRecord } from "./record";
import { isProcessInWindowsJob, isValidSessionToken } from "./windows-job";

export type OwnershipVerdict = "owned" | "dead" | "reused";

export interface OwnershipProbes {
	isAlive: (pid: number) => boolean;
	readSignature: (pid: number) => Promise<string> | string;
	isInJob: (token: string, pid: number) => Promise<boolean>;
}

const realProbes: OwnershipProbes = {
	isAlive: isProcessAlive,
	readSignature: readProcessStartSignature,
	isInJob: isProcessInWindowsJob,
};

/**
 * Classify a record: `owned` (live + identity-verified), `dead` (a recorded PID
 * is gone), or `reused` (a PID is alive but its identity no longer matches — a
 * different process now holds that PID). `token` is required on Windows to open
 * the ownership Job Object.
 */
export async function classifyOwnership(
	record: NativeSessionRecord,
	token: string | null,
	probes: OwnershipProbes = realProbes,
): Promise<OwnershipVerdict> {
	if (!probes.isAlive(record.host.pid) || !probes.isAlive(record.shell.pid)) return "dead";

	if (record.ownership.evidenceKind === "windows-job") {
		// A missing OR malformed token cannot open the ownership Job Object — treat
		// the session as unverifiable (reused), never throw and abort the whole
		// list/cleanup sweep on one corrupt token.
		if (!token || !isValidSessionToken(token)) return "reused";
		const hostOwned = await probes.isInJob(token, record.host.pid);
		const shellOwned = await probes.isInJob(token, record.shell.pid);
		return hostOwned && shellOwned ? "owned" : "reused";
	}

	// Both probes fork a `ps`; started together they cost one round trip, not two.
	const [hostSignature, shellSignature] = await Promise.all([
		probes.readSignature(record.host.pid),
		probes.readSignature(record.shell.pid),
	]);
	const hostMatches = startSignaturesMatch(record.host.startSignature, hostSignature);
	const shellMatches = startSignaturesMatch(record.shell.startSignature, shellSignature);
	return hostMatches && shellMatches ? "owned" : "reused";
}

/** Batch seam: one POSIX probe answers a whole pane set (seq 1388). */
export interface BatchOwnershipProbes {
	isAlive: (pid: number) => boolean;
	readSignatures: (pids: readonly number[]) => Promise<Map<number, string>>;
	isInJob: (token: string, pid: number) => Promise<boolean>;
}

const realBatchProbes: BatchOwnershipProbes = {
	isAlive: isProcessAlive,
	readSignatures: readProcessStartSignatures,
	isInJob: isProcessInWindowsJob,
};

/**
 * Classify a whole pane set with ONE `ps`, verdicts in input order.
 *
 * Identical verdict rules to {@link classifyOwnership}; only the probe is
 * shared, because a `ps` fork costs milliseconds and per-pane probing made a
 * six-pane sweep 12 forks. Windows records never reach the POSIX batch — their
 * Job Object membership is asked for exactly as before — and `readSignatures`
 * is not called at all when no record needs a signature.
 *
 * Every pid is judged on its OWN evidence: a pid missing from the batch is
 * unverifiable, so its record is `reused`, never owned, and never lends or
 * borrows proof from a sibling.
 */
export async function classifyOwnershipBatch(
	entries: readonly { record: NativeSessionRecord; token: string | null }[],
	probes: BatchOwnershipProbes = realBatchProbes,
): Promise<OwnershipVerdict[]> {
	const verdicts = new Array<OwnershipVerdict | null>(entries.length).fill(null);
	const needSignature: number[] = [];

	entries.forEach(({ record }, index) => {
		if (!probes.isAlive(record.host.pid) || !probes.isAlive(record.shell.pid)) {
			verdicts[index] = "dead";
			return;
		}
		if (record.ownership.evidenceKind === "windows-job") return;
		needSignature.push(record.host.pid, record.shell.pid);
	});

	const signatures =
		needSignature.length > 0 ? await probes.readSignatures(needSignature) : new Map<number, string>();

	await Promise.all(
		entries.map(async ({ record, token }, index) => {
			if (verdicts[index]) return;
			if (record.ownership.evidenceKind === "windows-job") {
				if (!token || !isValidSessionToken(token)) {
					verdicts[index] = "reused";
					return;
				}
				const [hostOwned, shellOwned] = await Promise.all([
					probes.isInJob(token, record.host.pid),
					probes.isInJob(token, record.shell.pid),
				]);
				verdicts[index] = hostOwned && shellOwned ? "owned" : "reused";
				return;
			}
			const hostMatches = startSignaturesMatch(record.host.startSignature, signatures.get(record.host.pid) ?? "");
			const shellMatches = startSignaturesMatch(record.shell.startSignature, signatures.get(record.shell.pid) ?? "");
			verdicts[index] = hostMatches && shellMatches ? "owned" : "reused";
		}),
	);

	return verdicts as OwnershipVerdict[];
}

export async function isOwnedAndAlive(
	record: NativeSessionRecord,
	token: string | null,
	probes: OwnershipProbes = realProbes,
): Promise<boolean> {
	return (await classifyOwnership(record, token, probes)) === "owned";
}
