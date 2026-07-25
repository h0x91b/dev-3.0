import { describe, expect, it } from "vitest";
import { mergeCompletionBlocker } from "../mergeCompletionBlocker";
import type { BranchStatus } from "../../../../shared/types";

function makeStatus(overrides?: Partial<BranchStatus>): BranchStatus {
	return {
		ahead: 0,
		behind: 0,
		canRebase: false,
		insertions: 0,
		deletions: 0,
		unpushed: 0,
		mergedByContent: true,
		diffFiles: 0,
		diffInsertions: 0,
		diffDeletions: 0,
		diffFileStats: [],
		prNumber: null,
		prUrl: null,
		mergeCompletionFingerprint: null,
		...overrides,
	};
}

const CTX = { compareRef: null, baseBranch: "main", taskStatus: "review-by-user" as const };

describe("mergeCompletionBlocker", () => {
	it("returns null for a merged branch, clean worktree, base compare and eligible status", () => {
		expect(mergeCompletionBlocker(makeStatus(), CTX)).toBeNull();
	});

	it("accepts origin/<base> as the base compare ref", () => {
		expect(mergeCompletionBlocker(makeStatus(), { ...CTX, compareRef: "origin/main" })).toBeNull();
	});

	it("names the compare ref when the user compares against something else", () => {
		expect(mergeCompletionBlocker(makeStatus(), { ...CTX, compareRef: "origin/develop" })).toEqual({
			key: "infoPanel.mergeCheckCompareRef",
			params: { ref: "origin/develop", branch: "main" },
		});
	});

	it("names uncommitted changes rather than claiming the branch is unmerged", () => {
		expect(mergeCompletionBlocker(makeStatus({ insertions: 4 }), CTX)?.key).toBe("infoPanel.mergeCheckUncommitted");
		expect(mergeCompletionBlocker(makeStatus({ deletions: 2 }), CTX)?.key).toBe("infoPanel.mergeCheckUncommitted");
	});

	it("reports not-merged only when the branch really is not merged", () => {
		expect(mergeCompletionBlocker(makeStatus({ mergedByContent: false }), CTX)).toEqual({
			key: "infoPanel.mergeCheckNotMerged",
			params: { branch: "main" },
		});
	});

	it("names the ineligible task status for a merged branch", () => {
		expect(mergeCompletionBlocker(makeStatus(), { ...CTX, taskStatus: "review-by-ai" })).toEqual({
			key: "infoPanel.mergeCheckStatusIneligible",
			statusParam: "status.reviewByAi",
		});
	});
});
