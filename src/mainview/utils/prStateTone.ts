import type { BranchStatus, TaskPRBadgeInfo } from "../../shared/types";
import type { TranslationKey } from "../i18n";
import { reportedPRState } from "./taskPrBadge";

/**
 * A pull request's lifecycle as GitHub colours it: open green, draft gray,
 * merged purple, closed red. `unknown` covers "nothing has polled it yet" and
 * renders neutral, so a loading badge never claims the PR is open.
 */
export type PRDisplayState = "open" | "draft" | "merged" | "closed" | "unknown";

/** Draft wins only over OPEN — a merged or closed draft reads as merged/closed. */
export function prDisplayState(state: string | null | undefined, isDraft?: boolean | null): PRDisplayState {
	switch (state?.toUpperCase()) {
		case "MERGED": return "merged";
		case "CLOSED": return "closed";
		case "OPEN": return isDraft === true ? "draft" : "open";
		default: return "unknown";
	}
}

/**
 * State of the PR a badge shows. The poller's own state wins; a same-number
 * branch status fills in when the badge was built without one.
 */
export function prBadgeDisplayState(
	prInfo: TaskPRBadgeInfo,
	branchStatus?: Pick<BranchStatus, "prNumber" | "prState"> | null,
): PRDisplayState {
	const state = reportedPRState(prInfo.number, [
		{ number: prInfo.number, state: prInfo.mergeState?.state },
		branchStatus && { number: branchStatus.prNumber, state: branchStatus.prState },
	]);
	return prDisplayState(state, prInfo.isDraft);
}

interface PRStateTone {
	/** Ink for the state word or a bare number. */
	text: string;
	/** Tinted chip: ink, paper and its hover. */
	chip: string;
	/** Absent for `unknown`: there is no state to name. */
	labelKey: TranslationKey | null;
}

const TONES: Record<PRDisplayState, PRStateTone> = {
	open: { text: "text-success", chip: "text-success-strong bg-success/10 hover:bg-success/20", labelKey: "task.prStatusOpen" },
	draft: { text: "text-fg-3", chip: "text-fg-2 bg-fg-3/10 hover:bg-fg-3/20", labelKey: "task.prDraft" },
	merged: { text: "text-pr-merged", chip: "text-pr-merged bg-pr-merged/10 hover:bg-pr-merged/20", labelKey: "task.prStatusMerged" },
	closed: { text: "text-danger", chip: "text-danger bg-danger/10 hover:bg-danger/20", labelKey: "task.prStatusClosed" },
	unknown: { text: "text-fg-3", chip: "text-fg-2 bg-fg-3/10 hover:bg-fg-3/20", labelKey: null },
};

export function prStateTone(state: PRDisplayState): PRStateTone {
	return TONES[state];
}
