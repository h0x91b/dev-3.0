import { describe, expect, it } from "vitest";
import type { Task, TaskPRBadgeInfo, TaskPRStatusCache } from "../../../shared/types";
import { inspectorPRBadge } from "../taskPrBadge";

const url = (n: number) => `https://github.com/acme/widget/pull/${n}`;

function cacheFor(number: number, state: string): TaskPRStatusCache {
	return {
		number,
		url: url(number),
		autoMergeEnabled: null,
		ciStatus: "success",
		reviewState: null,
		unresolvedCount: 0,
		mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state },
		checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
		prTitle: `PR ${number}`,
		isDraft: false,
		cachedAt: "2026-10-01T00:00:00.000Z",
	};
}

const task = (overrides: Partial<Task> = {}) => ({ id: "t1", prNumber: null, prUrl: null, prStatusCache: null, ...overrides }) as Task;

describe("inspectorPRBadge", () => {
	it("a live push wins over everything stored", () => {
		const pushed: TaskPRBadgeInfo = { number: 42, url: url(42), mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" } };
		expect(inspectorPRBadge(task({ prNumber: 42, prUrl: url(42), prStatusCache: cacheFor(42, "MERGED") }), pushed, null)).toBe(pushed);
	});

	it("without a push, a merged PR keeps its stored state and checks instead of reading as unknown", () => {
		const badge = inspectorPRBadge(
			task({ prNumber: 42, prUrl: url(42), prStatusCache: cacheFor(42, "MERGED") }),
			null,
			{ prNumber: 42, prUrl: url(42) },
		);
		expect(badge?.mergeState?.state).toBe("MERGED");
		expect(badge?.checks).toHaveLength(1);
		expect(badge?.prTitle).toBe("PR 42");
	});

	it("a replacement PR never inherits the previous PR's stored status", () => {
		const badge = inspectorPRBadge(
			task({ prNumber: 41, prUrl: url(41), prStatusCache: cacheFor(41, "MERGED") }),
			null,
			{ prNumber: 42, prUrl: url(42) },
		);
		expect(badge).toMatchObject({ number: 42, url: url(42), mergeState: null, checks: [] });
	});

	it("falls back to the sticky task PR when the branch check names none", () => {
		const badge = inspectorPRBadge(task({ prNumber: 42, prUrl: url(42), prStatusCache: cacheFor(42, "CLOSED") }), null, { prNumber: null, prUrl: null });
		expect(badge?.mergeState?.state).toBe("CLOSED");
	});

	it("borrows the stored URL when the branch check reports a number without one", () => {
		const badge = inspectorPRBadge(task({ prStatusCache: cacheFor(42, "MERGED") }), null, { prNumber: 42, prUrl: null });
		expect(badge).toMatchObject({ url: url(42), mergeState: { state: "MERGED" } });
	});

	it("returns nothing for a task with no PR at all", () => {
		expect(inspectorPRBadge(task(), null, null)).toBeNull();
	});
});
