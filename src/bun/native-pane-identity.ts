/**
 * The ONE read-only door from pane input to the session registry, and the one definition
 * of a native pane's process identity, so a pinned program and a live binding cannot
 * drift. See `decisions/201-backend-neutral-pane-input.md`.
 */

import { inspectRecordFile, type RecordProblem } from "./native-terminal-registry/record";
import type { NativeProcessIdentity } from "../shared/pane-input";

/** Why a record could not be accepted; re-exported so nothing else needs the registry. */
export type { RecordProblem };

/** A pane's two processes, as the registry record proved them. */
export interface NativeBoundIdentity {
	readonly sessionId: string;
	readonly host: NativeProcessIdentity;
	readonly shell: NativeProcessIdentity;
}

/** The shape this decoder accepts — a record, or anything record-like. */
interface RecordLike {
	readonly sessionId?: unknown;
	readonly host?: { readonly pid?: unknown; readonly startSignature?: unknown };
	readonly shell?: { readonly pid?: unknown; readonly startSignature?: unknown };
}

/**
 * The identity a record proves, or `null` when it cannot prove both processes. A pid
 * alone is never enough: the OS hands it to an unrelated successor.
 */
export function nativeBoundIdentityOf(record: RecordLike | null | undefined): NativeBoundIdentity | null {
	const host = record?.host;
	const shell = record?.shell;
	if (typeof record?.sessionId !== "string" || record.sessionId.length === 0) return null;
	if (typeof host?.startSignature !== "string" || host.startSignature.length === 0) return null;
	if (typeof shell?.startSignature !== "string" || shell.startSignature.length === 0) return null;
	if (!Number.isInteger(host.pid) || !Number.isInteger(shell.pid)) return null;
	return {
		sessionId: record.sessionId,
		host: { pid: host.pid as number, startSignature: host.startSignature },
		shell: { pid: shell.pid as number, startSignature: shell.startSignature },
	};
}

/**
 * What the registry says about `sessionId` right now. A failure names WHY: gone, corrupt,
 * unreadable and foreign-schema are different facts, and only one of them is death.
 */
export function inspectNativePaneIdentity(
	sessionId: string,
): { ok: true; identity: NativeBoundIdentity } | { ok: false; problem: RecordProblem } {
	const inspected = inspectRecordFile(sessionId);
	if (!inspected.ok) return inspected;
	const identity = nativeBoundIdentityOf(inspected.record);
	// An accepted record that still cannot prove both processes is unusable, not dead.
	if (!identity) return { ok: false, problem: { kind: "invalid-fields" } };
	return { ok: true, identity };
}
