import { describe, expect, it } from "vitest";
import { earlierPullRequests, recordPullRequestSighting } from "../../shared/task-pull-requests";
import type { Task, TaskPRStatusCache } from "../../shared/types";

const SEEN = "2026-09-29T10:00:00.000Z";
const LATER = "2026-09-30T10:00:00.000Z";

function mergedCache(number: number, title: string): TaskPRStatusCache {
	return {
		number,
		url: `https://github.com/o/r/pull/${number}`,
		ciStatus: null,
		reviewState: null,
		unresolvedCount: null,
		mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "MERGED" },
		checks: [],
		prTitle: title,
		isDraft: false,
		cachedAt: SEEN,
	};
}

type LedgerTask = Pick<Task, "prNumber" | "prUrl" | "prStatusCache" | "pullRequests">;

describe("recordPullRequestSighting", () => {
	it("starts the ledger with the first PR a task is seen with", () => {
		const ledger = recordPullRequestSighting({}, { number: 7, url: "https://github.com/o/r/pull/7", state: "open" }, SEEN);

		expect(ledger).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", firstSeenAt: SEEN }]);
	});

	it("reports no change for a repeated sighting, so a poll writes nothing new", () => {
		const task: LedgerTask = {
			prNumber: 7,
			prUrl: "https://github.com/o/r/pull/7",
			pullRequests: [{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", firstSeenAt: SEEN }],
		};

		expect(recordPullRequestSighting(task, { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN" }, LATER)).toBeNull();
	});

	it("keeps the state a finished PR reached", () => {
		const task: LedgerTask = {
			prNumber: 7,
			prUrl: "https://github.com/o/r/pull/7",
			pullRequests: [{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", firstSeenAt: SEEN }],
		};

		const ledger = recordPullRequestSighting(task, { number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", title: "First" }, LATER);

		expect(ledger).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", title: "First", firstSeenAt: SEEN }]);
	});

	it("records the replaced PR from the fields about to be overwritten", () => {
		// A task an older build tracked: legacy fields only, no ledger yet.
		const task: LedgerTask = {
			prNumber: 7,
			prUrl: "https://github.com/o/r/pull/7",
			prStatusCache: mergedCache(7, "First"),
		};

		const ledger = recordPullRequestSighting(task, { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN" }, LATER);

		expect(ledger).toEqual([
			{ number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", title: "First", firstSeenAt: LATER },
			{ number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", firstSeenAt: LATER },
		]);
	});

	it("does not borrow another PR's cached state for the replaced one", () => {
		const task: LedgerTask = { prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prStatusCache: mergedCache(5, "Other") };

		const ledger = recordPullRequestSighting(task, { number: 9, url: "https://github.com/o/r/pull/9" }, SEEN);

		expect(ledger?.[0]).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", firstSeenAt: SEEN });
	});
});

describe("earlierPullRequests", () => {
	it("lists every PR but the current one, newest first", () => {
		const task = {
			prNumber: 9,
			pullRequests: [
				{ number: 5, url: "u5", state: "CLOSED", firstSeenAt: SEEN },
				{ number: 7, url: "u7", state: "MERGED", firstSeenAt: SEEN },
				{ number: 9, url: "u9", state: "OPEN", firstSeenAt: LATER },
			],
		};

		expect(earlierPullRequests(task).map((entry) => entry.number)).toEqual([7, 5]);
	});

	it("is empty for a task without a ledger", () => {
		expect(earlierPullRequests({ prNumber: 3 })).toEqual([]);
	});
});
