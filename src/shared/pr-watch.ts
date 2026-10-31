import type { ScheduledMessageAuthor } from "./types";

/** A PR event an agent can subscribe to with `dev3 pr watch`. */
export const PR_WATCH_UNTIL = ["ci", "merged"] as const;
export type PrWatchUntil = (typeof PR_WATCH_UNTIL)[number];

/** One subscription on a task's PR; the app messages the agent once the event happens. */
export interface PrWatch {
	id: string;
	until: PrWatchUntil;
	prNumber: number;
	/** Local HEAD at subscribe time, moved to the PR head when the agent pushes again. */
	headSha: string;
	createdAt: string;
	/** `until: merged` only: the head whose CI failure was already reported. */
	failedNotifiedHead?: string;
	/** The first sample that looked finished (`at`: ms); a verdict needs the same head and total again a poll later. */
	ciSeen?: { head: string; total: number; at: number };
	/** Remote tips of the task branch when the watch was made; a sample showing one of them is the old push, not news. */
	tipsAtSubscribe?: string[];
	/** The agent process that subscribed; the message goes to its pane, never to a sibling's. */
	author?: ScheduledMessageAuthor;
	/**
	 * `--pr <N>` naming a PR that is not this task's own branch PR (a review target, a PR a
	 * coordinator follows): polled by number, judged on GitHub's head, never the task's PR.
	 */
	pinned?: true;
}

/** Distinct pinned PRs one task may follow: each costs a GitHub read every poll. */
export const PR_WATCH_MAX_PINNED_PRS = 10;

/** The watches that follow the task's own branch PR. */
export function branchPrWatches(watches: readonly PrWatch[] | null | undefined): PrWatch[] {
	return (watches ?? []).filter((watch) => !watch.pinned);
}

/** Every PR number the task follows by `--pr`, each once. */
export function pinnedPrNumbers(watches: readonly PrWatch[] | null | undefined): number[] {
	return [...new Set((watches ?? []).filter((watch) => watch.pinned).map((watch) => watch.prNumber))];
}

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_PR_WATCH_NO_PR`. */
export const PR_WATCH_NO_PR_PREFIX = "pr-watch-no-pr: ";
/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_PR_WATCH_PR_FINISHED`. */
export const PR_WATCH_PR_FINISHED_PREFIX = "pr-watch-pr-finished: ";

/** What happened to the PR, as the agent is told. */
export type PrStatusNotice =
	| { kind: "ci-passed"; sha: string; totalChecks: number }
	| { kind: "ci-failed"; sha: string; failedCount: number; totalChecks: number }
	| { kind: "merged" }
	| { kind: "closed" }
	| { kind: "replaced"; oldNumber: number };
