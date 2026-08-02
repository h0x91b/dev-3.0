/**
 * "Is this tmux session there?" for E2Es that must run on machines with no tmux
 * at all (seq 1381).
 *
 * A no-tmux assertion is the load-bearing half of every native-backend proof, so
 * it has to survive a runner that has no tmux binary — but it must NOT become a
 * blanket pass. Those are two different failures wearing the same shape:
 *
 *  - **tmux cannot be launched** (`TmuxSpawnError`: ENOENT/EACCES before the
 *    process starts). There is no tmux, therefore there is no tmux session —
 *    the strongest possible evidence for what the assertion wanted to prove.
 *    Answer `false` and let the check pass.
 *  - **anything else** — a non-zero exit (`TmuxError`), a permission problem
 *    once running, malformed output, a bug in the client. Those say nothing
 *    about whether a session exists, so swallowing them would turn "we could
 *    not look" into "we looked and it was clean". Rethrow.
 *
 * `tmux has-session` already reports a missing session as a clean non-zero exit
 * that the client turns into `false`, so the normal negative path never throws
 * and is not affected by any of this.
 */

import { isTmuxSpawnError } from "../tmux/errors";

/** What this helper needs of the tmux client: just the session probe. */
export type SessionProbe = (name: string, opts?: { socket: string }) => Promise<boolean>;

/**
 * Whether `name` exists, with "tmux is not installed / not executable" reported
 * as a plain absence. Every other failure propagates.
 */
export async function hasTmuxSessionOrAbsent(probe: SessionProbe, name: string, socket?: string): Promise<boolean> {
	try {
		return await probe(name, socket ? { socket } : undefined);
	} catch (err) {
		if (!isTmuxSpawnError(err)) throw err;
		return false;
	}
}
