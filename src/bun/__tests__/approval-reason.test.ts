import { describe, expect, it } from "vitest";
import { APPROVAL_REASON_MAX_LENGTH, approvalReasonFromParams, normalizeApprovalReason } from "../../shared/approval-reason";

describe("normalizeApprovalReason", () => {
	it("keeps plain text and line breaks, and drops control and bidi characters", () => {
		expect(normalizeApprovalReason("  one\r\ntwo\u0007\u202E three\t\n\n\n\nfour  ")).toBe("one\ntwo three \n\nfour");
	});

	it("leaves markup as literal text for the renderer to print", () => {
		expect(normalizeApprovalReason("<b>**bold**</b>")).toBe("<b>**bold**</b>");
	});

	it("returns null for anything without usable text", () => {
		for (const raw of [undefined, null, 42, "", "   ", "\u0000\u200B"]) expect(normalizeApprovalReason(raw)).toBeNull();
	});

	it("cuts an over-long reason to the cap with an ellipsis", () => {
		const cut = normalizeApprovalReason("x".repeat(APPROVAL_REASON_MAX_LENGTH * 2))!;
		expect([...cut]).toHaveLength(APPROVAL_REASON_MAX_LENGTH);
		expect(cut.endsWith("…")).toBe(true);
	});
});

describe("approvalReasonFromParams", () => {
	it("adds nothing when no reason was passed", () => {
		expect(approvalReasonFromParams({}, { seq: 1, title: "x" })).toEqual({});
	});

	it("attributes the reason only when a requester is given", () => {
		expect(approvalReasonFromParams({ reason: "why" })).toEqual({ reason: { text: "why" } });
		expect(approvalReasonFromParams({ reason: "why" }, { seq: 4, title: "Coordinator" })).toEqual({ reason: { text: "why", from: { seq: 4, title: "Coordinator" } } });
	});
});
