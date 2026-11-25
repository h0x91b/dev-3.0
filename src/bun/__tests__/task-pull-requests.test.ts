import { describe, expect, it } from "vitest";
import { allPullRequests, earlierPullRequests, recordPullRequestSighting, savedPrMergedFromBranch, trustedPrStatusCache } from "../../shared/task-pull-requests";
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
	it("starts the ledger with the first PR, writes nothing for a repeated sighting, and keeps the state a finished PR reached", () => {
		const ledger = recordPullRequestSighting({}, { number: 7, url: "https://github.com/o/r/pull/7", state: "open" }, SEEN);

		expect(ledger).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", firstSeenAt: SEEN }]);

		const task: LedgerTask = {
			prNumber: 7,
			prUrl: "https://github.com/o/r/pull/7",
			pullRequests: [{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", firstSeenAt: SEEN }],
		};

		expect(recordPullRequestSighting(task, { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN" }, LATER)).toBeNull();

		const finished = recordPullRequestSighting(task, { number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", title: "First" }, LATER);
		expect(finished).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", title: "First", firstSeenAt: SEEN }]);
	});

	it("records the replaced PR from the fields about to be overwritten, never borrowing another PR's cached state", () => {
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

		const stranger: LedgerTask = { prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prStatusCache: mergedCache(5, "Other") };
		expect(recordPullRequestSighting(stranger, { number: 9, url: "https://github.com/o/r/pull/9" }, SEEN)?.[0]).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", firstSeenAt: SEEN });
	});
});

describe("earlierPullRequests", () => {
	it("lists every PR but the current one, newest first, and nothing without a ledger", () => {
		const task = {
			prNumber: 9,
			pullRequests: [
				{ number: 5, url: "u5", state: "CLOSED", firstSeenAt: SEEN },
				{ number: 7, url: "u7", state: "MERGED", firstSeenAt: SEEN },
				{ number: 9, url: "u9", state: "OPEN", firstSeenAt: LATER },
			],
		};

		expect(earlierPullRequests(task).map((entry) => entry.number)).toEqual([7, 5]);
		expect(earlierPullRequests({ prNumber: 3 })).toEqual([]);
	});
});

describe("savedPrMergedFromBranch", () => {
	const cache = { ...mergedCache(7, "PR"), headRefName: "feat/a" };
	const task = (overrides: Partial<Pick<Task, "prNumber" | "prStatusCache">> = {}) => ({ prNumber: 7, prStatusCache: cache, ...overrides });

	it("is true for a merged PR opened from the same branch, false for another branch or no branch", () => {
		expect(savedPrMergedFromBranch(task(), "feat/a")).toBe(true);
		expect(savedPrMergedFromBranch(task(), "feat/b")).toBe(false);
		expect(savedPrMergedFromBranch(task(), "")).toBe(false);
		expect(savedPrMergedFromBranch(task(), null)).toBe(false);
	});

	it("is false for a pre-head-branch cache, a non-MERGED state, another PR number, or no cache", () => {
		expect(savedPrMergedFromBranch(task({ prStatusCache: { ...cache, headRefName: undefined } }), "feat/a")).toBe(false);
		const closed = { ...cache, mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "CLOSED" } };
		expect(savedPrMergedFromBranch(task({ prStatusCache: closed }), "feat/a")).toBe(false);
		expect(savedPrMergedFromBranch(task({ prNumber: 8 }), "feat/a")).toBe(false);
		expect(savedPrMergedFromBranch(task({ prNumber: null }), "feat/a")).toBe(false);
		expect(savedPrMergedFromBranch(task({ prStatusCache: null }), "feat/a")).toBe(false);
	});
});

describe("stale OPEN on a finished task", () => {
	const openCache = { ...mergedCache(7, "PR"), mergeState: { mergeable: null, status: null, state: "OPEN" } };

	it("the status cache reads unknown once the task is completed or cancelled", () => {
		expect(trustedPrStatusCache({ status: "completed", prStatusCache: openCache })?.mergeState).toBeNull();
		expect(trustedPrStatusCache({ status: "cancelled", prStatusCache: openCache })?.mergeState).toBeNull();
		expect(trustedPrStatusCache({ status: "review-by-user", prStatusCache: openCache })).toBe(openCache);
		const merged = mergedCache(7, "PR");
		expect(trustedPrStatusCache({ status: "completed", prStatusCache: merged })).toBe(merged);
	});

	it("the ledger and its legacy fallback do the same", () => {
		const ledgerTask = { status: "completed" as const, prNumber: 7, prUrl: "u7", prStatusCache: null, pullRequests: [
			{ number: 5, url: "u5", state: "OPEN", firstSeenAt: SEEN },
			{ number: 7, url: "u7", state: "OPEN", firstSeenAt: LATER },
		] };
		expect(allPullRequests(ledgerTask).map((entry) => entry.state)).toEqual([null, null]);
		expect(earlierPullRequests(ledgerTask).map((entry) => entry.state)).toEqual([null]);
		const legacy = { status: "completed" as const, prNumber: 7, prUrl: "u7", prStatusCache: openCache, pullRequests: null };
		expect(allPullRequests(legacy)[0].state).toBeNull();
	});
});
