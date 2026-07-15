import { describe, expect, it } from "vitest";
import { computeSignalKey, countUnresolvedReviewThreads, mapReviewDecision, normalizeChecks, parseAutoMergeEnabled, rollupCiStatus, summarizeMergeability } from "../pr-status";

describe("rollupCiStatus", () => {
	it("returns null for empty / non-array input", () => {
		expect(rollupCiStatus(undefined)).toBeNull();
		expect(rollupCiStatus([])).toBeNull();
		expect(rollupCiStatus("nope")).toBeNull();
	});

	it("returns success when all checks pass (CheckRun + StatusContext)", () => {
		expect(
			rollupCiStatus([
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ state: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "SKIPPED" },
			]),
		).toBe("success");
	});

	it("returns failure when any check fails or errors", () => {
		expect(
			rollupCiStatus([
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "FAILURE" },
			]),
		).toBe("failure");
		expect(rollupCiStatus([{ state: "ERROR" }])).toBe("failure");
	});

	it("returns pending when a check is still running and none failed", () => {
		expect(
			rollupCiStatus([
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "IN_PROGRESS", conclusion: null },
			]),
		).toBe("pending");
		expect(rollupCiStatus([{ state: "PENDING" }])).toBe("pending");
	});

	it("prioritizes failure over pending", () => {
		expect(
			rollupCiStatus([
				{ status: "IN_PROGRESS", conclusion: null },
				{ status: "COMPLETED", conclusion: "FAILURE" },
			]),
		).toBe("failure");
	});
});

describe("mapReviewDecision", () => {
	it("maps known GitHub decisions", () => {
		expect(mapReviewDecision("APPROVED")).toBe("approved");
		expect(mapReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
	});

	it("treats REVIEW_REQUIRED and empty as no review activity", () => {
		expect(mapReviewDecision("REVIEW_REQUIRED")).toBeNull();
		expect(mapReviewDecision("")).toBeNull();
		expect(mapReviewDecision(undefined)).toBeNull();
	});

	it("maps any other non-empty value to commented", () => {
		expect(mapReviewDecision("COMMENTED")).toBe("commented");
	});
});

describe("PR status detail helpers", () => {
	it("distinguishes missing, disabled, and enabled auto-merge data", () => {
		expect(parseAutoMergeEnabled(undefined)).toBeNull();
		expect(parseAutoMergeEnabled(null)).toBe(false);
		expect(parseAutoMergeEnabled({ enabledAt: "2026-07-15T18:00:00Z" })).toBe(true);
	});

	it("summarizes mergeability and common GitHub blocking reasons", () => {
		expect(summarizeMergeability({ mergeable: "MERGEABLE", status: "CLEAN" })).toEqual({ state: "mergeable", reason: null });
		expect(summarizeMergeability({ mergeable: "CONFLICTING", status: "DIRTY" })).toEqual({ state: "not_mergeable", reason: "conflict" });
		expect(summarizeMergeability({ mergeable: "MERGEABLE", status: "BLOCKED" })).toEqual({ state: "not_mergeable", reason: "blocked" });
		expect(summarizeMergeability({ mergeable: null, status: "BLOCKED" })).toEqual({ state: "not_mergeable", reason: "blocked" });
		expect(summarizeMergeability({ mergeable: "UNKNOWN", status: "UNKNOWN" })).toEqual({ state: "unknown", reason: null });
	});

	it("counts only explicitly unresolved review threads", () => {
		expect(countUnresolvedReviewThreads([
			{ isResolved: false },
			{ isResolved: true },
			{ isResolved: false },
			{},
			null,
		])).toBe(2);
		expect(countUnresolvedReviewThreads({ nodes: [{ isResolved: false }] })).toBe(0);
	});

	it("normalizes CheckRuns and StatusContexts into linkable checks", () => {
		expect(normalizeChecks([
			{ name: "build", status: "completed", conclusion: "success", detailsUrl: "https://ci/build" },
			{ context: "lint", state: "failure", targetUrl: "https://ci/lint" },
			{ status: "queued" },
			null,
		])).toEqual([
			{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/build" },
			{ name: "lint", status: null, conclusion: "FAILURE", detailsUrl: "https://ci/lint" },
			{ name: "", status: "QUEUED", conclusion: null, detailsUrl: null },
		]);
	});
});

describe("computeSignalKey", () => {
	it("ignores pending CI and null review (no worthy signal)", () => {
		expect(computeSignalKey("pending", null)).toBe("");
		expect(computeSignalKey(null, null)).toBe("");
	});

	it("includes settled CI and any review state, and is stable for dedupe", () => {
		expect(computeSignalKey("success", null)).toBe("ci:success");
		expect(computeSignalKey("failure", "changes_requested")).toBe("ci:failure|review:changes_requested");
		// Same inputs → same key (so the poller fires only once per state).
		expect(computeSignalKey("success", "approved")).toBe(computeSignalKey("success", "approved"));
	});
});
