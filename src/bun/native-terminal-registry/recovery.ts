/**
 * Post-reboot recovery classification for the native-session registry (seq 1294).
 *
 * After an OS reboot or a hard host loss the on-disk records outlive every
 * process they describe. This module turns one record + its ownership verdict
 * into an HONEST lifecycle answer plus an actionable diagnostic:
 *
 *   attachable       — live and identity-verified; a fresh app may reattach.
 *   lost-host-gone   — a recorded PID no longer exists (host crash / reboot).
 *   lost-pid-reused  — a recorded PID is alive but is a DIFFERENT process now.
 *   unreadable       — corrupt/partial/foreign record: fail closed, keep state.
 *
 * It deliberately contains no effects: no fs, no spawn, no process signals, no
 * launch. The identity proof stays where it already lives (ownership.ts →
 * `ps -o lstart` / Windows Job Object membership); recovery only reuses that
 * verdict. Nothing here can restart a shell, adopt a PID, or reach tmux — the
 * backend marker on every entry stays `native` by construction.
 */

import type { OwnershipVerdict } from "./ownership";
import type { NativeSessionRecord, RecordProblem } from "./record";
import { sessionDir } from "./paths";

export type RecoveryState = "attachable" | "lost-host-gone" | "lost-pid-reused" | "unreadable" | "absent";

export interface RecoveryEntry {
	sessionId: string;
	/** The explicit native marker: recovery never falls back to another backend. */
	backend: "native";
	state: RecoveryState;
	attachable: boolean;
	/** True only when the state is lost AND its cleanup token is present. */
	cleanupEligible: boolean;
	record: NativeSessionRecord | null;
	diagnostic: string;
}

export function isLostState(state: RecoveryState): boolean {
	return state === "lost-host-gone" || state === "lost-pid-reused";
}

export function recoveryStateFromVerdict(verdict: OwnershipVerdict): RecoveryState {
	if (verdict === "owned") return "attachable";
	return verdict === "dead" ? "lost-host-gone" : "lost-pid-reused";
}

function describeProblem(problem: RecordProblem): string {
	switch (problem.kind) {
		case "absent":
			return "no such session on disk";
		case "missing":
			return "record.json is missing — partial session state left behind";
		case "unreadable-file":
			return `record.json cannot be read (${problem.message})`;
		case "invalid-json":
			return "record.json is not valid JSON — a torn or hand-edited file";
		case "foreign-schema":
			return `record.json has schemaVersion ${JSON.stringify(problem.schemaVersion)}, which this build does not understand (another dev3 version owns it)`;
		case "invalid-fields":
			return "record.json is missing or mistyped required fields";
	}
}

/** Classify a readable record from its ownership verdict. */
export function recoveryEntryForRecord(
	sessionId: string,
	record: NativeSessionRecord,
	verdict: OwnershipVerdict,
	hasToken: boolean,
): RecoveryEntry {
	const state = recoveryStateFromVerdict(verdict);
	const pids = `host pid ${record.host.pid}, shell pid ${record.shell.pid}`;
	if (state === "attachable") {
		return {
			sessionId,
			backend: "native",
			state,
			attachable: true,
			cleanupEligible: false,
			record,
			diagnostic: `native session ${sessionId} is live and identity-verified (${pids}) — reattach with \`status\`/\`attach\`.`,
		};
	}
	const cause =
		state === "lost-host-gone"
			? `its recorded process is gone (${pids}) — the host died or the machine restarted`
			: `a recorded PID is alive but failed the identity proof (${pids}) — an unrelated process reused it and is left untouched`;
	const followUp = hasToken
		? "run `cleanup-stale` (or `recover --cleanup`) to drop this session's own metadata; nothing is attached, killed, or restarted"
		: `its cleanup token is missing, so metadata is kept (fail closed) — verify ${sessionDir(sessionId)} is yours before removing it by hand`;
	return {
		sessionId,
		backend: "native",
		state,
		attachable: false,
		cleanupEligible: hasToken,
		record,
		diagnostic: `native session ${sessionId} is lost: ${cause}. Recovery: ${followUp}.`,
	};
}

/** An id that cannot even name a session directory — reject before touching disk. */
export function recoveryEntryForInvalidId(sessionId: string): RecoveryEntry {
	return {
		sessionId,
		backend: "native",
		state: "unreadable",
		attachable: false,
		cleanupEligible: false,
		record: null,
		diagnostic: `invalid native session id ${JSON.stringify(sessionId)} — nothing was read, removed, or launched.`,
	};
}

/**
 * Classify a session directory whose record cannot be adopted — never cleanable.
 * A completely absent session is `absent`, not `unreadable`: there is no leftover
 * state to inspect, so the diagnostic must not send anyone hunting for one.
 */
export function recoveryEntryForUnreadable(sessionId: string, problem: RecordProblem): RecoveryEntry {
	if (problem.kind === "absent") {
		return {
			sessionId,
			backend: "native",
			state: "absent",
			attachable: false,
			cleanupEligible: false,
			record: null,
			diagnostic: `no native session ${sessionId} on disk — it was never started, or it stopped and cleaned up its own state. Nothing to recover.`,
		};
	}
	return {
		sessionId,
		backend: "native",
		state: "unreadable",
		attachable: false,
		cleanupEligible: false,
		record: null,
		diagnostic: `native session ${sessionId} cannot be classified: ${describeProblem(problem)}. Recovery: state in ${sessionDir(sessionId)} is left untouched — inspect it manually.`,
	};
}
