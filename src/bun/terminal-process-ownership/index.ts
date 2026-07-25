/**
 * Backend-neutral terminal process/port ownership accounting (seq 1293).
 *
 * Read-only: one claim → one snapshot of the processes a terminal session owns
 * and the ports they listen on, for both tmux and native sessions. See
 * contract.ts for the vocabulary and its boundaries.
 *
 * The tmux port type stays private (it is a backend-internal seam for tests);
 * nothing tmux-shaped is re-exported here.
 */

export {
	TERMINAL_OWNERSHIP_SCHEMA,
	TERMINAL_OWNERSHIP_VERSION,
	isOwnablePid,
	unprovedClaim,
	unprovedProof,
	verifiedClaim,
	verifiedProof,
	type OwnedProcess,
	type TerminalOwnership,
	type TerminalOwnershipClaim,
	type TerminalOwnershipCoverage,
	type TerminalOwnershipProof,
	type TerminalOwnershipRoot,
	type TerminalOwnershipRootRole,
	type TerminalOwnershipUnprovedState,
} from "./contract";
export {
	buildOwnershipSnapshot,
	collectOwnershipSnapshot,
	defaultOwnershipScanners,
	type TerminalOwnershipEvidence,
	type TerminalOwnershipScanners,
	type TerminalOwnershipSnapshot,
} from "./collector";
export {
	nativeOwnershipClaim,
	type NativeOwnershipInput,
	type NativeOwnershipRecordInput,
	type NativeOwnershipVerdict,
} from "./native-source";
export { tmuxOwnershipClaim, tmuxOwnershipClaimFromPanePids } from "./tmux-source";
