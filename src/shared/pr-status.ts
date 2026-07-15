import type { PRMergeState } from "./types";

/** Common mergeability outcomes used by the PR status popover. */
export type PRMergeability = "mergeable" | "not_mergeable" | "unknown";
export type PRMergeabilityReason = "conflict" | "blocked" | "behind" | "draft" | "unstable" | "hooks";

export interface PRMergeabilitySummary {
	state: PRMergeability;
	reason: PRMergeabilityReason | null;
}

/**
 * Summarize GitHub's mergeability fields for a compact status surface. A
 * blocking merge-state status wins because `mergeable` mainly describes
 * conflict-free merging, while `mergeStateStatus` describes whether GitHub
 * allows the merge right now.
 */
export function summarizeMergeability(mergeState: PRMergeState | null | undefined): PRMergeabilitySummary {
	if (!mergeState) return { state: "unknown", reason: null };

	const mergeable = mergeState.mergeable?.toUpperCase();
	const status = mergeState.status?.toUpperCase();

	if (mergeable === "CONFLICTING" || status === "DIRTY") {
		return { state: "not_mergeable", reason: "conflict" };
	}

	const blockedReasons: Record<string, PRMergeabilityReason> = {
		BLOCKED: "blocked",
		BEHIND: "behind",
		DRAFT: "draft",
		UNSTABLE: "unstable",
		HAS_HOOKS: "hooks",
	};
	const reason = status ? blockedReasons[status] : undefined;
	if (reason) return { state: "not_mergeable", reason };
	if (mergeable === "MERGEABLE" || status === "CLEAN" || status === "HAS_HOOKS") {
		return { state: "mergeable", reason: null };
	}

	return { state: "unknown", reason: null };
}
