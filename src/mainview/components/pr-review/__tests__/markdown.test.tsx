import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CommentMarkdown, MarkdownDocument, TaskDescriptionMarkdown } from "../markdown";
import { I18nProvider } from "../../../i18n";
import { installImmediateIntersectionObserver } from "../../../test-utils/immediate-intersection";

const mermaid = vi.hoisted(() => ({
	initialize: vi.fn(),
	render: vi.fn(),
}));

vi.mock("@streamdown/mermaid", () => ({
	createMermaidPlugin: () => ({
		name: "mermaid",
		type: "diagram",
		language: "mermaid",
		getMermaid: (config?: unknown) => {
			if (config) mermaid.initialize(config);
			return mermaid;
		},
	}),
}));

installImmediateIntersectionObserver();

beforeEach(() => {
	vi.clearAllMocks();
	mermaid.render.mockResolvedValue({
		svg: '<svg data-testid="rendered-mermaid" role="graphics-document"></svg>',
		diagramType: "flowchart-v2",
	});
});

describe("CommentMarkdown", () => {
	it("renders GitHub-flavored markdown with comment line breaks", () => {
		render(<CommentMarkdown body={"**bold** and `code`\nnext\n\n- item"} />);
		const container = screen.getByTestId("pr-comment-markdown");

		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("code")?.textContent).toBe("code");
		expect(container.querySelector("br")).not.toBeNull();
		expect(container.querySelector("li")?.textContent).toBe("item");
	});

	it("sanitizes scripts, event handlers, and styles", () => {
		render(
			<CommentMarkdown
				body={'hello <script>alert(1)</script> <style>body{display:none}</style><img src="x" onerror="alert(2)" style="color:red">'}
			/>,
		);
		const container = screen.getByTestId("pr-comment-markdown");

		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("style")).toBeNull();
		expect(container.querySelector("[onerror]")).toBeNull();
		expect(container.querySelector("[style]")).toBeNull();
	});

	it("neutralizes javascript links and opens safe links externally", () => {
		render(<CommentMarkdown body={"[unsafe](javascript:alert(1)) [docs](https://example.com)"} />);

		expect(screen.getByText(/unsafe/).closest("a")).toBeNull();
		expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/");
		expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
		expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("preserves repo-relative links through URL hardening", () => {
		render(<CommentMarkdown body={"[guide](docs/guide.md)"} />);

		expect(screen.getByRole("link", { name: "guide" })).toHaveAttribute("href", "docs/guide.md");
		expect(screen.getByRole("link", { name: "guide" })).toHaveAttribute("target", "_blank");
	});

	it("keeps unsafe schemes out of href, written plainly or wrapped as a token", () => {
		const unsafe = [
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"views://mainview/index.html",
		];
		const body = unsafe
			.flatMap((url, index) => [
				`[plain${index}](${url})`,
				`[wrapped${index}](https://dev3.invalid/0/${encodeURIComponent(url)})`,
			])
			.join(" ");
		render(<CommentMarkdown body={body} />);

		for (const link of screen.getByTestId("pr-comment-markdown").querySelectorAll("a")) {
			expect(link.getAttribute("href") ?? "").not.toMatch(/^(?:data|vbscript|file|views|javascript):/i);
		}
	});

	it("renders Mermaid code fences inline", async () => {
		render(<CommentMarkdown body={"```mermaid\nflowchart LR\nA --> B\n```"} />);

		await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
		expect(await screen.findByRole("img", { name: "Mermaid chart" })).toBeInTheDocument();
		expect(screen.getByTestId("rendered-mermaid")).toBeInTheDocument();
		expect(mermaid.render).toHaveBeenCalledWith(
			expect.stringMatching(/^mermaid-/),
			"flowchart LR\nA --> B\n",
		);
	});
});

describe("MarkdownDocument", () => {
	it("renders document structure without turning soft wraps into breaks", () => {
		render(<MarkdownDocument body={"# Title\n\nline one\nline two\n\n- item\n\n```\ncode\n```"} />);
		const container = screen.getByTestId("markdown-document");

		expect(container.querySelector("h1")?.textContent).toBe("Title");
		expect(container.querySelector("br")).toBeNull();
		expect(container.querySelector("li")?.textContent).toBe("item");
		expect(container.querySelector("pre")?.textContent).toContain("code");
	});

	it("renders sanitized markdown content", () => {
		render(<MarkdownDocument body={"## Guide\n\n**bold** <script>alert(1)</script>"} />);
		const container = screen.getByTestId("markdown-document");

		expect(container.querySelector("h2")?.textContent).toBe("Guide");
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("script")).toBeNull();
	});

	it("renders Mermaid fences with the secure Neo configuration", async () => {
		render(<MarkdownDocument body={"```mermaid\nflowchart LR\nA --> B\n```"} />);

		await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
		expect(await screen.findByRole("img", { name: "Mermaid chart" })).toBeInTheDocument();
		expect(screen.getByTestId("rendered-mermaid")).toBeInTheDocument();
		expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
			look: "neo",
			securityLevel: "strict",
			sequence: {
				useMaxWidth: false,
				wrap: true,
			},
			startOnLoad: false,
			suppressErrorRendering: true,
		}));
		expect(screen.queryByText("flowchart LR")).not.toBeInTheDocument();
	});

	it("keeps the source block when Mermaid rejects invalid syntax", async () => {
		mermaid.render.mockRejectedValueOnce(new Error("Parse error"));
		render(<MarkdownDocument body={"```mermaid\nnot a diagram\n```"} />);

		const source = await screen.findByText("not a diagram");
		await waitFor(() => expect(source.closest("pre")).toHaveAttribute(
			"data-mermaid-state",
			"error",
		));
	});
});

describe("TaskDescriptionMarkdown", () => {
	function renderDescription(body: string) {
		render(
			<I18nProvider>
				<TaskDescriptionMarkdown body={body} projectId="p1" taskId="t1" />
			</I18nProvider>,
		);
		return screen.getByTestId("task-description-markdown");
	}

	it("renders headings, lists, emphasis, inline and fenced code", () => {
		const container = renderDescription(
			"# Goal\n\n## Notes\n\n- first *item*\n- second\n\n1. one\n\nUse `bun run lint` now.\n\n```ts\nconst a = 1;\n```",
		);

		expect(container.querySelector("h1")?.textContent).toBe("Goal");
		expect(container.querySelector("h2")?.textContent).toBe("Notes");
		expect([...container.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["first item", "second"]);
		expect(container.querySelector("ol > li")?.textContent).toBe("one");
		expect(container.querySelector("em")?.textContent).toBe("item");
		expect(container.querySelector("p code")?.textContent).toBe("bun run lint");
		expect(container.querySelector("pre")?.textContent).toContain("const a = 1;");
		expect(container.textContent).not.toContain("# Goal");
	});

	it("keeps single line breaks as typed", () => {
		const container = renderDescription("line one\nline two");
		expect(container.querySelector("br")).not.toBeNull();
	});

	it("turns bare and bracketed task / PR refs into chips, inside lists and headings too", () => {
		const container = renderDescription("## Follow-up to seq:2076\n\n- see <seq:115>\n- and pr:2187 too");
		const refs = [...container.querySelectorAll("[data-task-ref]")].map((el) => el.getAttribute("data-task-ref"));

		expect(refs).toEqual(["seq:2076", "seq:115", "pr:2187"]);
		expect(container.querySelector("h2 [data-task-ref]")?.textContent).toBe("seq:2076");
		expect(container.querySelector("a[href^='seq:'], a[href^='pr:']")).toBeNull();
	});

	it("leaves refs inside code and inside a link's own label as plain text", () => {
		const container = renderDescription("`seq:9` and\n\n```\npr:3\n```\n\n[about seq:4](https://example.com)");

		expect(container.querySelectorAll("[data-task-ref]")).toHaveLength(0);
		expect(screen.getByRole("link", { name: "about seq:4" })).toHaveAttribute("href", "https://example.com/");
	});

	it("shows raw HTML as literal text and never executes it", () => {
		const container = renderDescription(
			'Fix <TaskCard> now <img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<div onclick="x()">block</div>',
		);

		expect(container.querySelector("script, img, div[onclick], taskcard")).toBeNull();
		expect(container.textContent).toContain("Fix <TaskCard> now");
		expect(container.textContent).toContain("<script>alert(2)</script>");
	});

	it("neutralizes javascript links", () => {
		renderDescription("[click](javascript:alert(1))");
		expect(screen.getByText(/click/).closest("a")).toBeNull();
	});
});
