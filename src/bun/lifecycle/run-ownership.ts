import type { Task } from "../../shared/types";
import { discoverPeerSockets } from "../instance-broadcast";
import { peerEndpointForPid } from "../native-pane-owner";

/** A run that only its owner may finish: boot recovery would destroy its workspace. */
export function hasInFlightRun(task: Task): boolean {
	const runtime = task.runtimeState?.runtime;
	if (runtime) return runtime === "preparing" || runtime === "tearing-down";
	return task.preparing === true;
}

export type ForeignRunOwner =
	| { kind: "owner"; pid: number }
	/** The run predates `ownerPid`; some live peer may own it, so nobody may reap it. */
	| { kind: "unattributed-peer"; peerCount: number };

/**
 * Which OTHER live dev3 instance owns this task's in-flight run, if any.
 *
 * Every instance sharing `~/.dev3.0` (installed app, a `bun run dev` build, a
 * headless `dev3 remote`) runs boot recovery. A run stamped with a live peer's
 * pid is that peer's; a run with no stamp was written by a build before
 * `ownerPid` existed, and while any peer is alive it may be that peer's. See
 * `decisions/2026/11/01/boot-recovery-respects-live-run-owner.md`.
 */
export function foreignRunOwner(task: Task): ForeignRunOwner | null {
	if (!hasInFlightRun(task)) return null;
	const ownerPid = task.runtimeState?.ownerPid;
	if (typeof ownerPid === "number") {
		if (ownerPid === process.pid) return null;
		return peerEndpointForPid(ownerPid) ? { kind: "owner", pid: ownerPid } : null;
	}
	const peerCount = discoverPeerSockets().length;
	return peerCount > 0 ? { kind: "unattributed-peer", peerCount } : null;
}
