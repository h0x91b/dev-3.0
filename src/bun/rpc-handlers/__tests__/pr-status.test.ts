import { describe, expect, it } from "vitest";
import { computeSignalKey, mapReviewDecision, rollupCiStatus } from "../pr-status";

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
