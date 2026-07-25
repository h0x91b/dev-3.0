/**
 * The adapter that turns a {@link TerminalOwnershipClaim} into a snapshot using
 * the app's EXISTING resource and listening-port scanners (seq 1293).
 *
 * There is deliberately no second monitoring subsystem here: descendants come
 * from the shared `ps` snapshot (`collectProcessInfo`, TTL-cached and already
 * shared by both pollers), per-PID cost from `aggregateResources`, and listening
 * ports from one `lsof` run parsed by `parseLsofOutput`. This module only decides
 * WHICH pids those scanners may attribute to a session.
 *
 * Two entry points:
 *  - {@link buildOwnershipSnapshot} — pure: claim + already-collected evidence.
 *  - {@link collectOwnershipSnapshot} — async: pulls the evidence from the shared
 *    scanners, and runs NO scanner at all when the claim is unproved.
 */

import type { PortInfo, ResourceUsage } from "../../shared/types";
import { collectDescendants, collectProcessInfo, getLsofOutput, parseLsofOutput } from "../port-scanner";
import { aggregateResources } from "../resource-monitor";
import {
	TERMINAL_OWNERSHIP_SCHEMA,
	TERMINAL_OWNERSHIP_VERSION,
	type OwnedProcess,
	type TerminalOwnership,
	type TerminalOwnershipClaim,
	type TerminalOwnershipCoverage,
} from "./contract";
import type { TerminalBackendIdentity } from "../../shared/terminal-backend-identity";

export interface TerminalOwnershipSnapshot {
	readonly schema: typeof TERMINAL_OWNERSHIP_SCHEMA;
	readonly version: typeof TERMINAL_OWNERSHIP_VERSION;
	readonly backend: TerminalBackendIdentity;
	readonly sessionId: string;
	readonly ownership: TerminalOwnership;
	/** Aggregated cost of the owned processes; null when ownership is unproved. */
	readonly resources: ResourceUsage | null;
	/** Listening TCP ports held by the owned processes; empty unless proved. */
	readonly ports: readonly PortInfo[];
	readonly coverage: TerminalOwnershipCoverage;
}

/**
 * Facts gathered from the shared scanners. A `null` field means the scanner
 * could not run on this platform — reported through `coverage`, never silently
 * flattened into "no children" / "no ports".
 */
export interface TerminalOwnershipEvidence {
	/** Parent PID → child PIDs, from the shared `ps` snapshot. */
	readonly tree: Map<number, number[]> | null;
	/** PID → { rss, cpu }, from the same `ps` snapshot. */
	readonly resources: Map<number, { rss: number; cpu: number }> | null;
	/** Raw `lsof -F pcn` output for LISTENing sockets. */
	readonly lsofOutput: string | null;
}

/** The scanners the collector is allowed to touch; faked in tests. */
export interface TerminalOwnershipScanners {
	processInfo: () => Promise<{
		tree: Map<number, number[]>;
		resources: Map<number, { rss: number; cpu: number }>;
	} | null>;
	lsof: () => Promise<string | null>;
}

/**
 * Process enumeration is POSIX-only: both scanners shell out to `ps` / `lsof`.
 * On Windows the native session's ownership proof is Job Object membership, which
 * proves identity but cannot enumerate a tree — so the evidence is reported
 * absent instead of guessed.
 */
const posixOnly = (): boolean => process.platform !== "win32";

export const defaultOwnershipScanners: TerminalOwnershipScanners = {
	processInfo: async () => (posixOnly() ? await collectProcessInfo() : null),
	// The scanners return "" when the tool is missing or failed — that is "not
	// measured", not "no listening ports".
	lsof: async () => (posixOnly() ? emptyToNull(await getLsofOutput()) : null),
};

function emptyToNull(output: string | null): string | null {
	return output !== null && output.length > 0 ? output : null;
}

function unprovedSnapshot(claim: TerminalOwnershipClaim, ownership: TerminalOwnership): TerminalOwnershipSnapshot {
	return {
		schema: TERMINAL_OWNERSHIP_SCHEMA,
		version: TERMINAL_OWNERSHIP_VERSION,
		backend: claim.backend,
		sessionId: claim.sessionId,
		ownership,
		resources: null,
		ports: [],
		coverage: { descendants: false, resources: false, ports: false },
	};
}

/**
 * Expand a claim into a snapshot from already-collected evidence. Pure and
 * synchronous — no spawns, no clock.
 */
export function buildOwnershipSnapshot(
	claim: TerminalOwnershipClaim,
	evidence: TerminalOwnershipEvidence,
): TerminalOwnershipSnapshot {
	if (!claim.proof.verified) {
		return unprovedSnapshot(claim, { state: claim.proof.state, reason: claim.proof.reason });
	}

	const processes: OwnedProcess[] = [];
	const pids = new Set<number>();
	for (const root of claim.roots) {
		if (pids.has(root.pid)) continue;
		pids.add(root.pid);
		processes.push({ pid: root.pid, role: root.role });
	}
	if (evidence.tree) {
		for (const root of claim.roots) {
			for (const pid of collectDescendants(root.pid, evidence.tree)) {
				if (pids.has(pid)) continue;
				pids.add(pid);
				processes.push({ pid, role: "descendant" });
			}
		}
	}

	const lsofOutput = emptyToNull(evidence.lsofOutput);
	return {
		schema: TERMINAL_OWNERSHIP_SCHEMA,
		version: TERMINAL_OWNERSHIP_VERSION,
		backend: claim.backend,
		sessionId: claim.sessionId,
		ownership: { state: "owned", processes },
		resources: evidence.resources ? aggregateResources(pids, evidence.resources) : null,
		ports: lsofOutput ? parseLsofOutput(lsofOutput, pids) : [],
		coverage: {
			descendants: evidence.tree !== null,
			resources: evidence.resources !== null,
			ports: lsofOutput !== null,
		},
	};
}

/**
 * Collect the evidence from the shared scanners and expand the claim. An
 * unproved claim short-circuits: no `ps`, no `lsof`, nothing attributed.
 */
export async function collectOwnershipSnapshot(
	claim: TerminalOwnershipClaim,
	scanners: TerminalOwnershipScanners = defaultOwnershipScanners,
): Promise<TerminalOwnershipSnapshot> {
	if (!claim.proof.verified) {
		return unprovedSnapshot(claim, { state: claim.proof.state, reason: claim.proof.reason });
	}
	const info = await scanners.processInfo();
	const lsofOutput = await scanners.lsof();
	return buildOwnershipSnapshot(claim, {
		tree: info?.tree ?? null,
		resources: info?.resources ?? null,
		lsofOutput,
	});
}
