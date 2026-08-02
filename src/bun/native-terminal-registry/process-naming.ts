/**
 * Human-readable identity for native terminal host processes (seq 1383).
 *
 * A user staring at Activity Monitor / Task Manager / `ps` must be able to tell
 * WHICH dev3 task owns a terminal host without decoding a UUID. The carrier is
 * the host's `argv0` — the one mechanism every supported OS surfaces somewhere
 * (see decision 192 for what each viewer actually displays).
 *
 * Both host launchers and the host itself derive the identity from the SAME two
 * inputs they already have — the session id and the shell launch env — so there
 * is no extra env contract and no plumbing through the coordinator.
 *
 * PRIVACY IS ENFORCED HERE, not by the callers. A process name is world-visible
 * on a shared machine, so only a strictly validated task number and pane id may
 * reach it. Task titles, prompts, tokens, worktree paths, and branch names are
 * structurally unable to appear: nothing else is ever read, and anything that
 * fails the patterns below is dropped rather than sanitised.
 *
 * Pure (no node/Bun imports) so it is unit-testable under every vitest config.
 */

/** Executable basename of the packaged host carrier — also the display prefix. */
export const NATIVE_HOST_PROCESS_NAME = "dev3-terminal-host";

/** Task env var carrying the human task number (`taskSeqLabel`), e.g. `1383-1`. */
export const TASK_SEQ_ENV = "DEV3_TASK_SEQ";

/** Env var the host exports into its shell so the shell knows its own pane. */
export const PANE_ID_ENV = "DEV3_PANE_ID";

/** A task number, optionally with a variant suffix: `1383` or `1383-1`. */
const SEQ_PATTERN = /^\d{1,9}(-\d{1,3})?$/;

/** The coordinator's logical pane id, always the session id's last segment. */
const PANE_SUFFIX_PATTERN = /-(pane-\d{1,4})$/;

export interface NativeProcessIdentity {
	/** Human task number, or null outside a task-owned session. */
	seq: string | null;
	/** Logical pane id (`pane-1`), or null for a session id without one. */
	paneId: string | null;
}

/** The logical pane id a coordinator encoded into a pane's session id. */
export function paneIdFromSessionId(sessionId: string): string | null {
	return PANE_SUFFIX_PATTERN.exec(sessionId)?.[1] ?? null;
}

/**
 * Identity for one native session. `env` is the shell launch env, which already
 * carries {@link TASK_SEQ_ENV} for every task-owned session.
 */
export function deriveNativeProcessIdentity(
	sessionId: string,
	env: Readonly<Record<string, string>> = {},
): NativeProcessIdentity {
	const rawSeq = env[TASK_SEQ_ENV];
	return {
		seq: typeof rawSeq === "string" && SEQ_PATTERN.test(rawSeq) ? rawSeq : null,
		paneId: paneIdFromSessionId(sessionId),
	};
}

/**
 * The `argv0` a host is spawned with, e.g. `dev3-terminal-host seq:1383 pane:1`.
 *
 * Falls back to the session id when no task number is in scope (the registry is
 * usable outside a task), which is opaque but still unambiguous and private-safe.
 */
export function formatNativeHostProcessName(identity: NativeProcessIdentity, sessionId: string): string {
	const parts: string[] = [NATIVE_HOST_PROCESS_NAME];
	if (identity.seq) parts.push(`seq:${identity.seq}`);
	if (identity.paneId) parts.push(identity.paneId.replace("pane-", "pane:"));
	if (parts.length === 1) parts.push(sessionId);
	return parts.join(" ");
}

/** Convenience: the argv0 for a session, derived straight from its launch env. */
export function nativeHostProcessName(sessionId: string, env: Readonly<Record<string, string>> = {}): string {
	return formatNativeHostProcessName(deriveNativeProcessIdentity(sessionId, env), sessionId);
}
