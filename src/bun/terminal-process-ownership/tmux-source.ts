/**
 * The tmux side of the ownership contract, and the ONLY file in this module that
 * speaks tmux (seq 1293).
 *
 * tmux itself is the ownership evidence: `#{pane_pid}` is reported by the live
 * server for a pane it created, so a pane PID is proved, not guessed. The pane
 * PIDs come from the existing `getSessionPanePids` / `getAllSessionPanePids`
 * helpers, which go through the typed tmux client singleton — nothing here
 * spawns tmux, recomputes a session name, or declares a `-F` format.
 *
 * A session the server reports no panes for is `unavailable`: it is not running
 * on this server, so nothing may be attributed to it.
 */

import { DEFAULT_TMUX_SOCKET } from "../tmux";
import { getSessionPanePids } from "../port-scanner";
import { unprovedClaim, verifiedClaim, type TerminalOwnershipClaim, type TerminalOwnershipRoot } from "./contract";

/** Every tmux capability this source consumes. */
export interface TmuxOwnershipPort {
	panePids(sessionName: string): Promise<readonly number[]>;
}

/** The production port over the existing pane-PID helper. */
export function tmuxOwnershipPort(socket: string = DEFAULT_TMUX_SOCKET): TmuxOwnershipPort {
	return { panePids: (sessionName) => getSessionPanePids(socket, sessionName) };
}

/**
 * Build a claim from pane PIDs a caller already has — e.g. a poller holding one
 * server-wide `getAllSessionPanePids` map, which must not pay for a second tmux
 * call per session. Pure.
 */
export function tmuxOwnershipClaimFromPanePids(
	sessionId: string,
	panePids: readonly number[],
): TerminalOwnershipClaim {
	if (panePids.length === 0) {
		return unprovedClaim("tmux", sessionId, "unavailable", "tmux reported no panes for this session");
	}
	const roots: TerminalOwnershipRoot[] = panePids.map((pid) => ({ pid, role: "pane" }));
	return verifiedClaim("tmux", sessionId, roots);
}

/**
 * Ask tmux which panes a session owns and build the claim. `sessions` lets a
 * caller fold sibling tmux sessions (e.g. a task's dev-server session) into one
 * accounting unit without this module knowing dev3's naming rules.
 */
export async function tmuxOwnershipClaim(
	sessionId: string,
	sessions: readonly string[] = [sessionId],
	port: TmuxOwnershipPort = tmuxOwnershipPort(),
): Promise<TerminalOwnershipClaim> {
	const panePids: number[] = [];
	for (const sessionName of sessions) {
		panePids.push(...(await port.panePids(sessionName)));
	}
	return tmuxOwnershipClaimFromPanePids(sessionId, panePids);
}
