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
import { readProcessStartSignature } from "./process-identity-native";
import type { NativeSessionRecord } from "./record";
import { isProcessInWindowsJob } from "./windows-job";

export type OwnershipVerdict = "owned" | "dead" | "reused";

export interface OwnershipProbes {
	isAlive: (pid: number) => boolean;
	readSignature: (pid: number) => string;
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
		if (!token) return "reused";
		const hostOwned = await probes.isInJob(token, record.host.pid);
		const shellOwned = await probes.isInJob(token, record.shell.pid);
		return hostOwned && shellOwned ? "owned" : "reused";
	}

	const hostMatches = startSignaturesMatch(record.host.startSignature, probes.readSignature(record.host.pid));
	const shellMatches = startSignaturesMatch(record.shell.startSignature, probes.readSignature(record.shell.pid));
	return hostMatches && shellMatches ? "owned" : "reused";
}

export async function isOwnedAndAlive(
	record: NativeSessionRecord,
	token: string | null,
	probes: OwnershipProbes = realProbes,
): Promise<boolean> {
	return (await classifyOwnership(record, token, probes)) === "owned";
}
