import { describe, expect, it } from "vitest";
import type { TaskPRBadgeInfo } from "../../../shared/types";
import { prBadgeDisplayState, prDisplayState, prStateTone } from "../prStateTone";

const badge = (overrides: Partial<TaskPRBadgeInfo> = {}): TaskPRBadgeInfo => ({ number: 7, url: "https://example.test/pull/7", ...overrides });

describe("prDisplayState", () => {
	it.each([
		["OPEN", false, "open"],
		["OPEN", null, "open"],
		["OPEN", true, "draft"],
		["open", true, "draft"],
		["MERGED", false, "merged"],
		["MERGED", true, "merged"],
		["CLOSED", false, "closed"],
		["CLOSED", true, "closed"],
		[null, true, "unknown"],
		[undefined, false, "unknown"],
		["", null, "unknown"],
		["WHATEVER", false, "unknown"],
	] as const)("%s with isDraft=%s reads as %s", (state, isDraft, expected) => {
		expect(prDisplayState(state, isDraft)).toBe(expected);
	});
});

describe("prStateTone", () => {
	it("gives each lifecycle state GitHub's hue and a word", () => {
		expect(prStateTone("open").chip).toContain("text-success");
		expect(prStateTone("merged").chip).toContain("text-pr-merged");
		expect(prStateTone("closed").chip).toContain("text-danger");
		expect(prStateTone("draft").chip).toContain("bg-fg-3/10");
		for (const state of ["open", "draft", "merged", "closed"] as const) {
			expect(prStateTone(state).labelKey).not.toBeNull();
		}
	});

	it("keeps unknown neutral and unnamed, so loading never looks open or merged", () => {
		const tone = prStateTone("unknown");
		expect(tone.labelKey).toBeNull();
		expect(`${tone.chip} ${tone.text}`).not.toMatch(/success|pr-merged|danger/);
	});
});

describe("prBadgeDisplayState", () => {
	it("prefers the polled state and falls back to a same-number branch status", () => {
		expect(prBadgeDisplayState(badge({ mergeState: { mergeable: null, status: null, state: "MERGED" } }), { prNumber: 7, prState: "OPEN" })).toBe("merged");
		expect(prBadgeDisplayState(badge(), { prNumber: 7, prState: "MERGED" })).toBe("merged");
		expect(prBadgeDisplayState(badge({ isDraft: true }), { prNumber: 7, prState: "OPEN" })).toBe("draft");
	});

	it("falls back to the task's stored cache for the same PR, draft included", () => {
		const cache = (state: string, isDraft: boolean, number = 7) => ({ number, mergeState: { mergeable: null, status: null, state }, isDraft });
		expect(prBadgeDisplayState(badge(), null, cache("MERGED", false))).toBe("merged");
		expect(prBadgeDisplayState(badge(), null, cache("OPEN", true))).toBe("draft");
		expect(prBadgeDisplayState(badge(), { prNumber: 7, prState: "CLOSED" }, cache("OPEN", false))).toBe("closed");
		expect(prBadgeDisplayState(badge(), null, cache("MERGED", false, 6))).toBe("unknown");
	});

	it("ignores a branch status about a different PR", () => {
		expect(prBadgeDisplayState(badge(), { prNumber: 6, prState: "MERGED" })).toBe("unknown");
		expect(prBadgeDisplayState(badge(), null)).toBe("unknown");
	});
});
