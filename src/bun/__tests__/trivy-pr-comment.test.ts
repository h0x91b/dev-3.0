import { describe, expect, it } from "vitest";

const {
	buildTrivyCommentBody,
	shouldSkipTrivyComment,
} = require("../trivy-pr-comment.js") as {
	buildTrivyCommentBody: (results: string) => string | null;
	shouldSkipTrivyComment: (results: string) => boolean;
};

describe("shouldSkipTrivyComment", () => {
	it("skips clean summary tables with zero findings", () => {
		const results = `
Report Summary

┌────────┬──────┬─────────────────┬─────────┐
│ Target │ Type │ Vulnerabilities │ Secrets │
├────────┼──────┼─────────────────┼─────────┤
│ .      │ fs   │ 0               │ -       │
└────────┴──────┴─────────────────┴─────────┘
Legend:
- '-': Not scanned
- '0': Clean (no security findings detected)
`;

		expect(shouldSkipTrivyComment(results)).toBe(true);
		expect(buildTrivyCommentBody(results)).toBeNull();
	});

	it("does not skip tables with actual findings", () => {
		const results = `
Report Summary

┌────────┬──────┬─────────────────┬─────────┐
│ Target │ Type │ Vulnerabilities │ Secrets │
├────────┼──────┼─────────────────┼─────────┤
│ .      │ fs   │ 2               │ -       │
└────────┴──────┴─────────────────┴─────────┘
`;

		expect(shouldSkipTrivyComment(results)).toBe(false);
		expect(buildTrivyCommentBody(results)).toContain("| . | fs | 2 | - |");
	});

	it("renders raw output for non-table reports that should be posted", () => {
		const results = "scanner failed to produce a table";

		expect(shouldSkipTrivyComment(results)).toBe(false);
		expect(buildTrivyCommentBody(results)).toContain("### Raw Output");
	});
});
