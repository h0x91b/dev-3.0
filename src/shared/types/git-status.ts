/**
 * The two things "Merge" can mean. An open pull request for the branch makes it
 * `pull-request` (GitHub merges it, so review and CI still gate the landing);
 * anything else is the local squash into the base branch. The renderer sends the
 * route it promised the user so the backend can refuse a mismatch instead of
 * running the other one.
 */
export type MergeRoute = "pull-request" | "local-squash";

/**
 * A merged or closed PR stays on screen, but it is no longer the branch's live
 * PR: it cannot be merged, and it must not stop the next PR from being opened.
 * An unknown state (offline, not fetched yet) counts as live.
 */
export function isPullRequestFinished(state: string | null | undefined): boolean {
	const normalized = state?.toUpperCase();
	return normalized === "MERGED" || normalized === "CLOSED";
}

export interface BranchStatus {
	ahead: number;
	behind: number;
	// No commit that both the compare ref and HEAD descend from, so neither count
	// can be measured — typically a shallow local clone whose truncated history
	// hides the fork point. `ahead`/`behind` are 0 here and mean "unknown", never
	// "nothing": git's own degraded answer is each side's whole history, which
	// once read as "1889 ahead" for a branch that was 2 ahead.
	baseUnreachable: boolean;
	canRebase: boolean;
	insertions: number;
	deletions: number;
	// Commits that exist on no remote: -1 = nothing of this branch is preserved
	// anywhere, 0 = everything is on a remote (under this branch's name or any
	// other), N = N commits missing from `origin/<branch>`. See `getUnpreservedCount`.
	unpushed: number;
	// Whether a ref other than this task's own branch still reaches HEAD — a local
	// branch, a tag or a remote-tracking ref. Deleting the branch cannot destroy
	// commits another ref holds, so this separates "preserved nowhere" from "not
	// pushed, but kept in this repository". False whenever it could not be proven,
	// including on a timeout. See `isPreservedOutsideBranch`.
	preservedOutsideBranch: boolean;
	mergedByContent: boolean; // true if git diff base HEAD is empty (squash/rebase merge)
	diffFiles: number; // total files changed in branch vs base
	diffInsertions: number; // total lines added in branch vs base
	diffDeletions: number; // total lines removed in branch vs base
	diffFileStats: Array<{ path: string; insertions: number; deletions: number }>; // per-file stats for branch vs base
	prNumber: number | null; // associated PR number for this branch, null if none was detected
	prUrl: string | null; // full GitHub PR URL, null if no associated PR was detected
	prState: string | null; // GitHub state of that PR (OPEN / MERGED / CLOSED), null when unknown
	mergeCompletionFingerprint: string | null; // stable key for deduping the merged-branch completion prompt
	// Whether the project repo has an `origin` remote at all. A repo added from a
	// local folder has none, and then Push / Create PR / PR + auto-merge cannot
	// work — they must read as unavailable instead of failing on click.
	hasRemote: boolean;
	// Whether `origin` is a GitHub host. `gh` is the only forge client dev3 speaks,
	// so a GitLab/Gitea remote must not be offered Create PR — the handoff prompt
	// would hand the agent a `gh pr create` it cannot run.
	remoteIsGitHub: boolean;
	// Commits on `origin/<branch>` that HEAD does not have. Non-zero means a plain
	// push is refused as non-fast-forward — almost always because the branch was
	// rebased after being pushed — so Push has to become a leased force push.
	// 0 when never pushed, when up to date, or when there is no remote.
	remoteAhead: number;
}

/**
 * Work that deleting this task's worktree would destroy, answered with LOCAL git
 * only — no `git fetch`, no `gh`, no cross-task semaphore. {@link BranchStatus}
 * covers the same ground but spends seconds on the network, which is unusable in
 * front of a confirmation dialog (see `confirmTaskCompletion`). Deliberately
 * omits "pushed but not merged": that work lives on the remote, so it is not at
 * risk, and judging it needs a fresh fetch.
 */
export interface UnsavedWork {
	insertions: number;
	deletions: number;
	// Commits that exist on no remote: -1 = nothing of this branch is preserved
	// anywhere, 0 = everything is on a remote (under this branch's name or any
	// other), N = N commits missing from `origin/<branch>`. See `getUnpreservedCount`.
	unpushed: number;
	// See BranchStatus.preservedOutsideBranch — another ref still reaches HEAD, so
	// deleting this branch destroys nothing. False whenever it could not be proven.
	preservedOutsideBranch: boolean;
	ahead: number; // commits ahead of the base branch, per the last known origin ref
	baseUnreachable: boolean; // see BranchStatus.baseUnreachable — `ahead` is 0 and unknown
}

export type TaskDiffMode = "branch" | "uncommitted" | "unpushed" | "recent";

export type TaskDiffFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "type-changed"
	| "untracked"
	| "unknown";

/**
 * Why a diff answers a different question than the one asked.
 * `no-upstream` — the branch was never pushed, so "unpushed" fell back to the base.
 * `missing-compare-ref` — the compare ref does not exist in this repo (typically
 * `origin/<base>` in a repo with no remote); the diff is empty because nothing
 * could be compared, which must never read as "no changes".
 * `no-merge-base` — the compare ref exists but shares no ancestor with HEAD, so
 * `git diff <ref>...HEAD` refused to run. Same emptiness, different cause and
 * different fix: the history is truncated (shallow clone), not the ref missing.
 */
export type TaskDiffFallbackReason = "no-upstream" | "missing-compare-ref" | "no-merge-base";

export interface TaskDiffFile {
	id: string;
	status: TaskDiffFileStatus;
	displayPath: string;
	oldPath: string | null;
	newPath: string | null;
	oldContent: string;
	newContent: string;
	hunks: string[] | null;
	insertions: number;
	deletions: number;
}

export interface TaskDiffSummary {
	files: number;
	insertions: number;
	deletions: number;
}

export type TaskDiffSkippedReason = "binary" | "too-large";

export interface TaskDiffSkippedFile {
	id: string;
	status: TaskDiffFileStatus;
	reason: TaskDiffSkippedReason;
	displayPath: string;
	oldPath: string | null;
	newPath: string | null;
	oldSize: number | null;
	newSize: number | null;
}

export interface TaskDiffResponse {
	mode: TaskDiffMode;
	compareRef: string | null;
	compareLabel: string;
	fallbackReason: TaskDiffFallbackReason | null;
	// For `recent` mode only: the effective (clamped) commit count actually diffed
	// (`HEAD~recentCount..HEAD`). May be smaller than the requested count when the
	// branch has fewer of its own commits; 0 when the branch has none. Null for
	// every other mode. The renderer uses it for the honest "Last N commits" label.
	recentCount: number | null;
	summary: TaskDiffSummary;
	files: TaskDiffFile[];
	skippedFiles: TaskDiffSkippedFile[];
}
