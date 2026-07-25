/**
 * The native side of the ownership contract (seq 1293).
 *
 * A native session's ownership evidence already exists: the persisted session
 * record pins the host + shell PIDs, and the session store's ownership check
 * classifies them as `owned` / `dead` / `reused` (POSIX start signature, or
 * Windows Job Object membership). This module ONLY translates that verdict into
 * a {@link TerminalOwnershipClaim} — it never re-derives identity, never signals
 * a PID, and never falls back to tmux.
 *
 * STANDALONE BY CONTRACT. It imports nothing from the native session store: the
 * input types below are plain data, deliberately shaped to be structurally
 * compatible with that store's public read APIs (`readRecord` → record,
 * `classifyOwnership` → verdict), so a caller passes those values straight
 * through without this file referencing that module (whose isolation test
 * forbids exactly that).
 *
 * A verdict of anything but `owned` — or missing host data — yields an explicit
 * unproved claim, so a stale or reused PID is never counted as session cost.
 */

import {
	isOwnablePid,
	unprovedClaim,
	verifiedClaim,
	type TerminalOwnershipClaim,
	type TerminalOwnershipRoot,
} from "./contract";

/** Structurally matches the native session store's `OwnershipVerdict`. */
export type NativeOwnershipVerdict = "owned" | "dead" | "reused";

/**
 * The record facts this module reads. Field names mirror the persisted native
 * session record so a caller can pass one directly; everything is optional
 * because a lookup may find no record at all.
 */
export interface NativeOwnershipRecordInput {
	sessionId?: string;
	host?: { pid?: number };
	shell?: { pid?: number };
}

export interface NativeOwnershipInput {
	/** The session id being accounted for. */
	sessionId: string;
	/** The persisted record, or null/undefined when nothing was found on disk. */
	record?: NativeOwnershipRecordInput | null;
	/** The store's ownership verdict; absent means ownership was never checked. */
	verdict?: NativeOwnershipVerdict | null;
}

/**
 * Translate a native record + verdict into a claim.
 *
 * `dead` → `stale`, `reused` → `reused`, and every "we cannot tell" case
 * (no record, no verdict, foreign record, unusable PIDs) → `unavailable`.
 */
export function nativeOwnershipClaim(input: NativeOwnershipInput): TerminalOwnershipClaim {
	const unproved = (state: "unavailable" | "stale" | "reused", reason: string): TerminalOwnershipClaim =>
		unprovedClaim("native", input.sessionId, state, reason);

	const record = input.record ?? null;
	if (!record) return unproved("unavailable", "no native session record was found for this session");
	if (typeof record.sessionId === "string" && record.sessionId !== input.sessionId) {
		return unproved("unavailable", "the native session record belongs to a different session id");
	}

	const verdict = input.verdict ?? null;
	if (verdict === "dead") return unproved("stale", "the recorded native host or shell process has exited");
	if (verdict === "reused") return unproved("reused", "a recorded native PID is alive but is no longer our process");
	if (verdict !== "owned") return unproved("unavailable", "native session ownership was not verified");

	const hostPid = record.host?.pid;
	const shellPid = record.shell?.pid;
	if (!isOwnablePid(hostPid) || !isOwnablePid(shellPid)) {
		return unproved("unavailable", "the native session record carried no usable host or shell PID");
	}

	const roots: TerminalOwnershipRoot[] = [
		{ pid: hostPid, role: "host" },
		{ pid: shellPid, role: "shell" },
	];
	return verifiedClaim("native", input.sessionId, roots);
}
