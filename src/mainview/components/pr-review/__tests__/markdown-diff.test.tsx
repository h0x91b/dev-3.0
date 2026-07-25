import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildMarkdownDiffBlocks, MarkdownRichDiff } from "../markdown-diff";

describe("buildMarkdownDiffBlocks", () => {
	it("returns null when both sides render the same document", () => {
		expect(buildMarkdownDiffBlocks("# Same\n\ntext\n", "# Same\n\ntext\n")).toBeNull();
	});

	it("ignores blank-line-only churn", () => {
		expect(buildMarkdownDiffBlocks("# Same\n\ntext\n", "# Same\n\n\n\ntext\n\n")).toBeNull();
	});

	it("marks a replaced paragraph as removed then added", () => {
		const blocks = buildMarkdownDiffBlocks("# Title\n\nold text\n", "# Title\n\nnew text\n");
		expect(blocks?.map((block) => block.kind)).toEqual(["context", "removed", "added"]);
		expect(blocks?.[0].html).toContain("<h1>Title</h1>");
		expect(blocks?.[1].html).toContain("old text");
		expect(blocks?.[2].html).toContain("new text");
	});

	it("scopes a list change to the changed item", () => {
		const blocks = buildMarkdownDiffBlocks("- one\n- two\n", "- one\n- inserted\n- two\n");
		expect(blocks?.filter((block) => block.kind !== "context")).toHaveLength(1);
		const added = blocks?.find((block) => block.kind === "added");
		expect(added?.html).toContain("inserted");
		expect(added?.html).not.toContain("one");
	});

	it("keeps consecutive unchanged list items in one list", () => {
		const blocks = buildMarkdownDiffBlocks("- one\n- two\n\npara\n", "- one\n- two\n\nother\n");
		const context = blocks?.find((block) => block.kind === "context");
		expect(context?.html.match(/<ul>/g)).toHaveLength(1);
		expect(context?.html).toContain("<li>one</li>");
		expect(context?.html).toContain("<li>two</li>");
	});

	it("keeps the numbering of an ordered list item", () => {
		const blocks = buildMarkdownDiffBlocks("1. first\n2. second\n", "1. first\n2. changed\n");
		expect(blocks?.find((block) => block.kind === "added")?.html).toContain("<ol start=\"2\">");
	});

	it("sanitizes markup on both sides", () => {
		const blocks = buildMarkdownDiffBlocks(
			"<script>alert(1)</script>gone\n",
			"<img src=\"x\" onerror=\"alert(2)\">stays\n",
		);
		const html = blocks?.map((block) => block.html).join("");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("onerror");
	});
});

describe("MarkdownRichDiff", () => {
	it("tags every block with its change kind", () => {
		const blocks = buildMarkdownDiffBlocks("old\n", "new\n") ?? [];
		render(<MarkdownRichDiff blocks={blocks} />);

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.querySelector("[data-diff-kind='removed']")?.textContent).toContain("old");
		expect(host.querySelector("[data-diff-kind='added']")?.textContent).toContain("new");
	});
});
