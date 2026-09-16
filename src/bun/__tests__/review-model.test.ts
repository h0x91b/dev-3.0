import { describe, expect, it } from "vitest";
import {
	MAX_REVIEW_COMMENTS_KEPT,
	appendReviewComment,
	buildReviewPrompt,
	countOpenReviewComments,
	describeReviewAnchor,
	markReviewCommentsSent,
	reopenReviewComment,
	replyToReviewComment,
	resolveReviewComment,
	resolveReviewCommentId,
	reviewCommentsForArtifact,
	updateReviewCommentBody,
	type ReviewComment,
} from "../../shared/review";

const diffComment: ReviewComment = {
	id: "c-diff-0001",
	body: "Divide by runs, not tasks.",
	createdAt: "2026-09-15T10:00:00.000Z",
	anchor: { kind: "diff-line", fileId: "f1", filePath: "src/stats.ts", side: "newFile", startLine: 42, endLine: 43 },
};

const artifactComment: ReviewComment = {
	id: "c-art-0002",
	body: "This number is wrong.",
	createdAt: "2026-09-15T10:01:00.000Z",
	anchor: {
		kind: "artifact-element",
		artifactId: "a1",
		version: 3,
		title: "Cockpit",
		selector: ".kpi:nth-child(2)",
		text: "Agent success 94.2%",
		heading: "Overview",
	},
};

describe("review prompt", () => {
	it("renders a diff anchor as the classic <file> block, with the comment id and the CLI footer", () => {
		const text = buildReviewPrompt([{
			id: diffComment.id,
			anchor: diffComment.anchor,
			comment: diffComment.body,
			snippet: { before: "const ok = a;", after: "const ok = b;" },
			origin: "local",
			author: null,
		}]);
		expect(text).toBe([
			"<reviews>",
			`<review id="c-diff-0001">`,
			`<file src="src/stats.ts" line="42-43">`,
			"-const ok = a;",
			"+const ok = b;",
			"</file>",
			"<comment>Divide by runs, not tasks.</comment>",
			"</review>",
			"</reviews>",
			"---",
			"Above my comments about code changes, read them carefully and process all of them.",
			"When a comment is handled run `dev3 review resolve <id> --reply \"what you did\"`; to answer without closing it run `dev3 review reply <id> \"...\"`. `dev3 review list` shows what is still open.",
		].join("\n"));
	});

	it("renders an artifact anchor with title, version, selector and heading, and tells the agent to republish", () => {
		const text = buildReviewPrompt([{ id: artifactComment.id, anchor: artifactComment.anchor, comment: artifactComment.body, origin: "local", author: null }]);
		expect(text).toContain(`<artifact title="Cockpit" version="3" selector=".kpi:nth-child(2)" heading="Overview">`);
		expect(text).toContain("Agent success 94.2%\n</artifact>");
		expect(text).toContain("republish it under the same title");
		expect(text).toContain("Above my review comments");
	});

	it("keeps GitHub entries id-less and marked by origin, and skips the CLI footer when nothing is resolvable", () => {
		const text = buildReviewPrompt([{ id: null, anchor: diffComment.anchor, comment: "Use toBeCloseTo", origin: "github", author: "diverru" }]);
		expect(text).toContain(`<review origin="github" author="diverru">`);
		expect(text).not.toContain("dev3 review resolve");
		expect(text).toContain("Reviews marked origin=\"github\"");
	});

	it("escapes quotes in attribute values", () => {
		const text = buildReviewPrompt([{
			id: "x",
			anchor: { ...artifactComment.anchor, title: 'Say "hi"', heading: null },
			comment: "c",
			origin: "local",
			author: null,
		}]);
		expect(text).toContain('title="Say &quot;hi&quot;"');
		expect(text).not.toContain("heading=");
	});
});

describe("review mutations", () => {
	it("describes anchors for the CLI table", () => {
		expect(describeReviewAnchor(diffComment.anchor)).toBe("src/stats.ts:42-43");
		expect(describeReviewAnchor(artifactComment.anchor)).toBe("Cockpit v3 › Overview › Agent success 94.2%");
	});

	it("resolves ids by exact match or unique prefix", () => {
		const list = [diffComment, artifactComment];
		expect(resolveReviewCommentId(list, "c-diff-0001")).toEqual({ id: "c-diff-0001" });
		expect(resolveReviewCommentId(list, "c-art")).toEqual({ id: "c-art-0002" });
		expect(resolveReviewCommentId(list, "c-")).toMatchObject({ error: expect.stringContaining("Ambiguous") });
		expect(resolveReviewCommentId(list, "zzz")).toMatchObject({ error: expect.stringContaining("not found") });
	});

	it("resolve stamps who closed it and appends the reply; reopen removes the marks", () => {
		const sent = markReviewCommentsSent([diffComment], ["c-diff-0001"], "2026-09-15T11:00:00.000Z");
		expect(sent[0].sentAt).toBe("2026-09-15T11:00:00.000Z");
		const resolved = resolveReviewComment(sent, "c-diff-0001", "agent", "Now divides by runs.", "2026-09-15T12:00:00.000Z");
		expect(resolved[0]).toMatchObject({ resolvedAt: "2026-09-15T12:00:00.000Z", resolvedBy: "agent" });
		expect(resolved[0].replies).toHaveLength(1);
		expect(resolved[0].replies?.[0]).toMatchObject({ author: "agent", body: "Now divides by runs." });
		expect(countOpenReviewComments(resolved)).toBe(0);
		const reopened = reopenReviewComment(resolved, "c-diff-0001");
		expect(reopened[0].resolvedAt).toBeUndefined();
		expect(reopened[0].resolvedBy).toBeUndefined();
		expect(reopened[0].replies).toHaveLength(1);
	});

	it("throws on an unknown id for resolve, reply and reopen", () => {
		expect(() => resolveReviewComment([diffComment], "nope", "agent")).toThrow(/not found/);
		expect(() => replyToReviewComment([diffComment], "nope", { body: "x", author: "user" })).toThrow(/not found/);
		expect(() => reopenReviewComment([diffComment], "nope")).toThrow(/not found/);
	});

	it("editing clears the sent mark so the new text is deliverable again", () => {
		const sent = markReviewCommentsSent([diffComment], ["c-diff-0001"]);
		const edited = updateReviewCommentBody(sent, "c-diff-0001", "Divide by runs.");
		expect(edited[0].body).toBe("Divide by runs.");
		expect(edited[0].sentAt).toBeUndefined();
	});

	it("filters artifact comments by artifact id", () => {
		expect(reviewCommentsForArtifact([diffComment, artifactComment], "a1")).toEqual([artifactComment]);
		expect(reviewCommentsForArtifact([diffComment, artifactComment], "other")).toEqual([]);
	});

	it("evicts resolved comments before open ones when the cap is hit", () => {
		let list: ReviewComment[] = [];
		for (let i = 0; i < MAX_REVIEW_COMMENTS_KEPT; i++) {
			list = appendReviewComment(list, { ...diffComment, id: `c${i}`, resolvedAt: i === 5 ? "2026-01-01T00:00:00.000Z" : undefined });
		}
		const next = appendReviewComment(list, { ...diffComment, id: "newest" });
		expect(next).toHaveLength(MAX_REVIEW_COMMENTS_KEPT);
		expect(next.find((c) => c.id === "c5")).toBeUndefined();
		expect(next.find((c) => c.id === "c0")).toBeDefined();
		expect(next.at(-1)?.id).toBe("newest");
	});
});
