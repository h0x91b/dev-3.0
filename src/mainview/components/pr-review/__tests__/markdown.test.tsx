import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommentMarkdown, renderCommentMarkdown } from "../markdown";

describe("renderCommentMarkdown", () => {
	it("renders GitHub-flavored markdown", () => {
		const html = renderCommentMarkdown("**bold** and `code`\n\n- item");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>code</code>");
		expect(html).toContain("<li>item</li>");
	});

	it("strips script tags and inline event handlers", () => {
		const html = renderCommentMarkdown('hello <script>alert(1)</script> <img src="x" onerror="alert(2)">');
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("alert(1)");
	});

	it("neutralizes javascript: links", () => {
		const html = renderCommentMarkdown("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
	});

	it("forces links to open externally", () => {
		const html = renderCommentMarkdown("[docs](https://example.com)");
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("drops style tags and style attributes", () => {
		const html = renderCommentMarkdown('<style>body{display:none}</style><p style="color:red">x</p>');
		expect(html).not.toContain("<style");
		expect(html).not.toContain("style=");
	});
});

describe("CommentMarkdown", () => {
	it("renders sanitized markdown content", () => {
		render(<CommentMarkdown body={"**important** <script>alert(1)</script>"} />);
		const container = screen.getByTestId("pr-comment-markdown");
		expect(container.querySelector("strong")?.textContent).toBe("important");
		expect(container.querySelector("script")).toBeNull();
	});
});
