export interface PRInfo {
	number: number;
	url: string;
	headRefName: string;
}

/**
 * CI/checks rollup for a task's open PR, collapsed from GitHub's
 * `statusCheckRollup`. `null` = no PR / no checks reported yet.
 */
export type PRCIStatus = "success" | "failure" | "pending";

/**
 * PR review outcome, mapped from GitHub's `reviewDecision` (plus a derived
 * `commented` when reviews exist without an approve/changes decision).
 * `null` = no review activity yet.
 */
export type PRReviewState = "approved" | "changes_requested" | "commented";

/** Raw GitHub review decision used to explain why a merge is blocked. */
export type PRReviewDecision = "approved" | "changes_requested" | "review_required";

/** A single check reported by GitHub's `statusCheckRollup`. */
export interface PRCheckInfo {
	name: string;
	status: string | null;
	conclusion: string | null;
	detailsUrl: string | null;
}

/** Mergeability and merge-state status reported by GitHub for an open PR. */
export interface PRMergeState {
	mergeable: string | null;
	status: string | null;
	state?: string | null;
}

/**
 * Persisted rich status for a task's associated pull request. This is deliberately
 * additive task metadata: the renderer can show it immediately while the next
 * GitHub refresh is in flight.
 */
export interface TaskPRStatusCache {
	number: number;
	url: string;
	/** `null` when the GitHub response did not include auto-merge data yet. */
	autoMergeEnabled?: boolean | null;
	ciStatus: PRCIStatus | null;
	reviewState: PRReviewState | null;
	/** Raw GitHub review decision; optional for caches written before this field existed. */
	reviewDecision?: PRReviewDecision | null;
	unresolvedCount: number | null;
	mergeState: PRMergeState | null;
	checks: PRCheckInfo[];
	prTitle: string | null;
	isDraft: boolean | null;
	cachedAt: string;
}

/**
 * What an on-demand PR refresh achieved: `updated` pushed fresh GitHub data,
 * `unavailable` means GitHub did not answer (the last known status stays),
 * `not-found` means GitHub reports no PR for this branch, `skipped` means the
 * task is not watched (finished, virtual, or no worktree).
 */
export interface RefreshTaskPrStatusResult {
	outcome: "updated" | "unavailable" | "not-found" | "skipped";
}

/** One entry of {@link Task.pullRequests}. */
export interface TaskPullRequestRecord {
	number: number;
	url: string;
	title?: string | null;
	/** GitHub's state when last seen (OPEN / MERGED / CLOSED); absent when never fetched. */
	state?: string | null;
	firstSeenAt: string;
}

/**
 * Per-task PR badge data shown on the Kanban card: PR number/url (from
 * `getProjectPRs` or sticky task fields) plus optional status detail from the
 * background PR poller's `taskPrStatus` push.
 */
export interface TaskPRBadgeInfo {
	number: number;
	url: string;
	autoMergeEnabled?: boolean | null;
	ciStatus?: PRCIStatus | null;
	reviewState?: PRReviewState | null;
	reviewDecision?: PRReviewDecision | null;
	unresolvedCount?: number | null;
	mergeState?: PRMergeState | null;
	checks?: PRCheckInfo[];
	prTitle?: string | null;
	isDraft?: boolean | null;
}

// ---- PR review comments (read-only GitHub layer in the diff viewer) ----

/** Which side of the PR diff a review thread anchors to (GitHub GraphQL `DiffSide`). */
export type PRReviewThreadSide = "LEFT" | "RIGHT";

/** One comment inside a review thread or the PR conversation. Body is GitHub-flavored markdown. */
export interface PRReviewComment {
	id: string;
	/** GitHub login; null for ghost/deleted accounts. */
	author: string | null;
	/** True when the author is an app/bot account (login ends with `[bot]` or GraphQL __typename Bot). */
	isBot: boolean;
	body: string;
	createdAt: string;
	/** Deep link to this exact comment on GitHub. */
	url: string;
}

/** An inline review thread on the PR diff, as reported by GraphQL `reviewThreads`. */
export interface PRReviewThread {
	id: string;
	path: string;
	/** Line in the current PR-head diff; null when GitHub can no longer anchor it. */
	line: number | null;
	/** Line in the diff the comment was originally made on. */
	originalLine: number | null;
	/** First line of a multi-line thread; null for single-line threads. */
	startLine: number | null;
	diffSide: PRReviewThreadSide;
	isResolved: boolean;
	isOutdated: boolean;
	comments: PRReviewComment[];
}

/** Full read-only comment payload for a task's PR, fetched on diff open / manual refresh. */
export interface TaskPRCommentsPayload {
	prNumber: number;
	prUrl: string;
	fetchedAt: string;
	threads: PRReviewThread[];
	/** Top-level PR conversation comments (issue comments), oldest first. */
	conversation: PRReviewComment[];
}
