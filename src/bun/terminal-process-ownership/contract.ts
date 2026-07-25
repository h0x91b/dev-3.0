/**
 * Backend-neutral process ownership vocabulary for one terminal session
 * (tmux-removal roadmap seq 1293).
 *
 * ONE contract answers "which processes does this terminal session own, and was
 * that ownership actually PROVED?" for both backends. A backend produces a
 * {@link TerminalOwnershipClaim} — verified root processes plus the proof that
 * backs them — and `collector.ts` expands it into a
 * {@link TerminalOwnershipSnapshot} using the app's existing `ps`/`lsof`
 * scanners.
 *
 * Hard boundaries of this seam:
 *  - Ownership is never inferred from a task id or a bare PID. A claim carries a
 *    proof, and an unproved claim becomes an explicit
 *    `unavailable` / `stale` / `reused` snapshot with a reason — never an empty
 *    "owned" set that silently reads as "this session costs nothing".
 *  - This slice is READ-ONLY accounting: nothing here signals, kills, launches,
 *    attaches to, or selects a backend.
 *  - This file is pure vocabulary: no spawns, no clock, no tmux, no registry.
 */

import type { TerminalBackendIdentity } from "../../shared/terminal-backend-identity";

export const TERMINAL_OWNERSHIP_SCHEMA = "dev3-terminal-process-ownership" as const;
export const TERMINAL_OWNERSHIP_VERSION = 1 as const;

/** Why a root process belongs to the session — for logs and diagnostics. */
export type TerminalOwnershipRootRole = "host" | "shell" | "pane";

/** A process the backend PROVED it owns, before descendants are expanded. */
export interface TerminalOwnershipRoot {
	readonly pid: number;
	readonly role: TerminalOwnershipRootRole;
}

/** A process attributed to the session: a proved root or one of its children. */
export interface OwnedProcess {
	readonly pid: number;
	readonly role: TerminalOwnershipRootRole | "descendant";
}

/**
 * Why a claim carries no proof:
 *  - `unavailable` — ownership could not be determined at all (no session state,
 *    no usable host data, no verdict). Nothing is attributed and no scanner runs.
 *  - `stale` — the recorded processes are gone; the session's cost is zero and
 *    must not be attributed to whatever holds those PIDs now.
 *  - `reused` — a recorded PID is alive but is no longer the process we started.
 */
export type TerminalOwnershipUnprovedState = "unavailable" | "stale" | "reused";

export type TerminalOwnershipProof =
	| { readonly verified: true }
	| { readonly verified: false; readonly state: TerminalOwnershipUnprovedState; readonly reason: string };

/** What a backend claims to own for one session, plus the proof behind it. */
export interface TerminalOwnershipClaim {
	readonly backend: TerminalBackendIdentity;
	/** The product's session id (tmux session name / native session id). */
	readonly sessionId: string;
	/** Proved roots; meaningful only when `proof.verified` is true. */
	readonly roots: readonly TerminalOwnershipRoot[];
	readonly proof: TerminalOwnershipProof;
}

export type TerminalOwnership =
	| { readonly state: "owned"; readonly processes: readonly OwnedProcess[] }
	| { readonly state: TerminalOwnershipUnprovedState; readonly reason: string };

/**
 * What the snapshot could actually measure. A `false` flag means the fact was
 * not observable (no process table on this platform, no `lsof`), NOT that the
 * session has no children / no ports.
 */
export interface TerminalOwnershipCoverage {
	readonly descendants: boolean;
	readonly resources: boolean;
	readonly ports: boolean;
}

export function isOwnablePid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

export function verifiedProof(): TerminalOwnershipProof {
	return { verified: true };
}

export function unprovedProof(state: TerminalOwnershipUnprovedState, reason: string): TerminalOwnershipProof {
	return { verified: false, state, reason };
}

export function unprovedClaim(
	backend: TerminalBackendIdentity,
	sessionId: string,
	state: TerminalOwnershipUnprovedState,
	reason: string,
): TerminalOwnershipClaim {
	return { backend, sessionId, roots: [], proof: unprovedProof(state, reason) };
}

/**
 * Build a verified claim from proved roots. Unusable PIDs are dropped, and a
 * claim left with no root degrades to `unavailable` — a verified-but-empty claim
 * would be indistinguishable from a session that genuinely costs nothing.
 */
export function verifiedClaim(
	backend: TerminalBackendIdentity,
	sessionId: string,
	roots: readonly TerminalOwnershipRoot[],
): TerminalOwnershipClaim {
	const seen = new Set<number>();
	const usable: TerminalOwnershipRoot[] = [];
	for (const root of roots) {
		if (!isOwnablePid(root.pid) || seen.has(root.pid)) continue;
		seen.add(root.pid);
		usable.push({ pid: root.pid, role: root.role });
	}
	if (usable.length === 0) {
		return unprovedClaim(backend, sessionId, "unavailable", "no usable root process was proved for this session");
	}
	return { backend, sessionId, roots: usable, proof: verifiedProof() };
}
