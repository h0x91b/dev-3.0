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
	/** The agent process that subscribed; the message goes to its pane, never to a sibling's. */
	author?: ScheduledMessageAuthor;
}

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_PR_WATCH_NO_PR`. */
export const PR_WATCH_NO_PR_PREFIX = "pr-watch-no-pr: ";

/** What happened to the PR, as the agent is told. */
export type PrStatusNotice =
	| { kind: "ci-passed"; sha: string; totalChecks: number }
	| { kind: "ci-failed"; sha: string; failedCount: number; totalChecks: number }
	| { kind: "merged" }
	| { kind: "closed" };
