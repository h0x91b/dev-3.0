import type { PRCheckInfo, PRCIStatus, PRReviewState } from "../../shared/types";
export { summarizeMergeability } from "../../shared/pr-status";
export type { PRMergeability, PRMergeabilityReason, PRMergeabilitySummary } from "../../shared/pr-status";

// Dependency-free helpers for collapsing GitHub PR status/review data into the
// app's CI + review signals. Kept side-effect-free (no electrobun/pty imports)
// so they can be unit-tested in isolation, like git-poll-throttle.ts.

/**
 * Collapse GitHub's `statusCheckRollup` (array of CheckRun / StatusContext
 * nodes) into a single CI verdict. Any failing/errored check ⇒ `failure`; else
 * any still-running/queued check ⇒ `pending`; all complete & passing ⇒
 * `success`. Empty / unrecognized ⇒ `null` (no checks → no badge).
 */
export function rollupCiStatus(rollup: unknown): PRCIStatus | null {
	if (!Array.isArray(rollup) || rollup.length === 0) return null;
	let anyPending = false;
	let sawKnown = false;
	for (const check of rollup) {
		if (!check || typeof check !== "object") continue;
		const c = check as Record<string, unknown>;
		// CheckRun: { status: COMPLETED|IN_PROGRESS|QUEUED..., conclusion: SUCCESS|FAILURE|... }
		// StatusContext: { state: SUCCESS|FAILURE|PENDING|ERROR }
		const status = typeof c.status === "string" ? c.status.toUpperCase() : null;
		const conclusion = typeof c.conclusion === "string" ? c.conclusion.toUpperCase() : null;
		const state = typeof c.state === "string" ? c.state.toUpperCase() : null;
		sawKnown = true;
		if (status && status !== "COMPLETED") {
			anyPending = true;
			continue;
		}
		const verdict = conclusion ?? state;
		if (!verdict) {
			anyPending = true;
			continue;
		}
		if (verdict === "PENDING" || verdict === "EXPECTED" || verdict === "QUEUED" || verdict === "IN_PROGRESS") {
			anyPending = true;
			continue;
		}
		// SUCCESS / NEUTRAL / SKIPPED are non-blocking; everything else is a failure.
		if (verdict !== "SUCCESS" && verdict !== "NEUTRAL" && verdict !== "SKIPPED") {
			return "failure";
		}
	}
	if (!sawKnown) return null;
	return anyPending ? "pending" : "success";
}

/**
 * Count unresolved review threads from one or more GraphQL `reviewThreads`
 * node arrays. The GraphQL API is the source of truth because the REST-backed
 * `gh pr view/list --json` fields do not expose thread resolution.
 */
export function countUnresolvedReviewThreads(threads: unknown): number {
	if (!Array.isArray(threads)) return 0;
	return threads.reduce((count, thread) => {
		if (!thread || typeof thread !== "object") return count;
		return (thread as Record<string, unknown>).isResolved === false ? count + 1 : count;
	}, 0);
}

/**
 * Normalize GitHub CheckRun and StatusContext nodes into the renderer's small
 * per-check shape. The two node families use `name`/`context`,
 * `status`/`state`, and `detailsUrl`/`targetUrl` respectively.
 */
export function normalizeChecks(rollup: unknown): PRCheckInfo[] {
	if (!Array.isArray(rollup)) return [];
	return rollup.flatMap((check): PRCheckInfo[] => {
		if (!check || typeof check !== "object") return [];
		const c = check as Record<string, unknown>;
		const name = typeof c.name === "string"
			? c.name
			: typeof c.context === "string"
				? c.context
				: "";
		const status = typeof c.status === "string" ? c.status.toUpperCase() : null;
		const conclusion = typeof c.conclusion === "string"
			? c.conclusion.toUpperCase()
			: typeof c.state === "string"
				? c.state.toUpperCase()
				: null;
		const detailsUrl = typeof c.detailsUrl === "string"
			? c.detailsUrl
			: typeof c.targetUrl === "string"
				? c.targetUrl
				: null;
		return [{ name, status, conclusion, detailsUrl }];
	});
}

/**
 * Convert `gh pr view --json autoMergeRequest` into the renderer's boolean
 * flag. A missing property means an older/partial response, while an explicit
 * `null` means GitHub reported that auto-merge is not configured.
 */
export function parseAutoMergeEnabled(value: unknown): boolean | null {
	if (value === undefined) return null;
	return value !== null;
}

/**
 * Map GitHub's `reviewDecision` to our review state. GitHub only emits
 * APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED (or empty), so in practice
 * only `approved` / `changes_requested` / `null` are reachable today.
 * REVIEW_REQUIRED / empty ⇒ `null` (no review activity yet). The `commented`
 * fallback is forward-compat only (see the inline note below).
 */
export function mapReviewDecision(reviewDecision: unknown): PRReviewState | null {
	if (typeof reviewDecision !== "string" || reviewDecision === "") return null;
	const d = reviewDecision.toUpperCase();
	if (d === "APPROVED") return "approved";
	if (d === "CHANGES_REQUESTED") return "changes_requested";
	if (d === "REVIEW_REQUIRED") return null;
	// Future-proofing: GitHub's `reviewDecision` enum only ever returns
	// APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / "" — it never emits
	// COMMENTED, so this branch is effectively unreachable today. Kept as
	// forward-compat for when `commented` is fed from a richer source (e.g.
	// reviews / latestReviews counts) rather than `reviewDecision`.
	return "commented";
}

/**
 * Build a stable key for the worthy signals on a PR, used to dedupe attention.
 * CI counts only once settled (success/failure — `pending` is noise); any
 * non-null review state counts. Empty string ⇒ nothing worth pinging about.
 */
export function computeSignalKey(ciStatus: PRCIStatus | null, reviewState: PRReviewState | null): string {
	const parts: string[] = [];
	if (ciStatus === "success" || ciStatus === "failure") parts.push(`ci:${ciStatus}`);
	if (reviewState) parts.push(`review:${reviewState}`);
	return parts.join("|");
}

const CI_REASON: Record<"success" | "failure", string> = {
	success: "CI passed",
	failure: "CI failed",
};
const REVIEW_REASON: Record<PRReviewState, string> = {
	approved: "PR approved",
	changes_requested: "Changes requested",
	commented: "PR has comments",
};

/** Human-readable reason string for the bell / notification, from the signals. */
export function reasonForSignal(ciStatus: PRCIStatus | null, reviewState: PRReviewState | null): string {
	const parts: string[] = [];
	if (ciStatus === "success" || ciStatus === "failure") parts.push(CI_REASON[ciStatus]);
	if (reviewState) parts.push(REVIEW_REASON[reviewState]);
	return parts.join(" · ");
}
