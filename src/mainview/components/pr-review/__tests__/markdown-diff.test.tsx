import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../../i18n";
import { buildMarkdownDiffBlocks, MarkdownRichDiff, type MarkdownDiffBlock } from "../markdown-diff";
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

describe("buildMarkdownDiffBlocks source lines", () => {
	it("gives every block the line it starts on in its own side of the diff", () => {
		const oldSource = "# Title\n\nintro\n\ngone paragraph\n\ntail\n";
		const newSource = "# Title\n\nintro\n\nfresh paragraph\n\ntail\n";
		const blocks = buildMarkdownDiffBlocks(oldSource, newSource)!;

		const removed = blocks.find((block) => block.kind === "removed")!;
		const added = blocks.find((block) => block.kind === "added")!;
		expect(removed).toMatchObject({ startLine: 5, source: "gone paragraph" });
		expect(added).toMatchObject({ startLine: 5, source: "fresh paragraph" });
		// The leading context group starts at line 1 and covers both blocks.
		expect(blocks[0]).toMatchObject({ kind: "context", startLine: 1 });
	});

	it("rejoins a grouped run with the blank lines it actually had", () => {
		const oldSource = "one\n\n\n\ntwo\n\nremoved\n";
		const newSource = "one\n\n\n\ntwo\n";
		const blocks = buildMarkdownDiffBlocks(oldSource, newSource)!;
		const context = blocks.find((block) => block.kind === "context")!;

		// Three blank lines separated the paragraphs, so "two" must still land on
		// line 5 — a fixed "\n\n" join would have dragged it up to line 3.
		expect(context.startLine).toBe(1);
		expect(context.source).toBe("one\n\n\n\ntwo");
	});

	it("keeps consecutive list items in one block", () => {
		const blocks = buildMarkdownDiffBlocks("- a\n- b\n", "- a\n- b\n- c\n")!;
		const added = blocks.find((block) => block.kind === "added")!;
		expect(added).toMatchObject({ startLine: 3, source: "- c" });
	});
});

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
		expect(blocks?.[0].source).toBe("# Title");
		expect(blocks?.[1].source).toBe("old text");
		expect(blocks?.[2].source).toBe("new text");
	});

	it("scopes a list change to the changed item", () => {
		const blocks = buildMarkdownDiffBlocks("- one\n- two\n", "- one\n- inserted\n- two\n");
		expect(blocks?.filter((block) => block.kind !== "context")).toHaveLength(1);
		const added = blocks?.find((block) => block.kind === "added");
		expect(added?.source).toContain("inserted");
		expect(added?.source).not.toContain("one");
	});

	it("keeps consecutive unchanged list items in one list", () => {
		const blocks = buildMarkdownDiffBlocks("- one\n- two\n\npara\n", "- one\n- two\n\nother\n");
		const context = blocks?.find((block) => block.kind === "context");
		expect(context?.source).toBe("- one\n- two");
	});

	it("keeps the numbering of an ordered list item", () => {
		const blocks = buildMarkdownDiffBlocks("1. first\n2. second\n", "1. first\n2. changed\n");
		expect(blocks?.find((block) => block.kind === "added")?.source).toBe("2. changed");
	});
});

function renderDiff(props: Parameters<typeof MarkdownRichDiff>[0]) {
	return render(
		<I18nProvider>
			<MarkdownRichDiff {...props} />
		</I18nProvider>,
	);
}

/** A document whose only edit sits far from both ends. */
function longDocument(edited: boolean): string {
	const body = Array.from({ length: 20 }, (_, index) =>
		index === 10 && edited ? "paragraph ten, edited" : `paragraph ${index}`);
	return `# Guide\n\n${body.join("\n\n")}\n`;
}

describe("MarkdownRichDiff", () => {
	it("tags every block with its change kind", () => {
		const blocks = buildMarkdownDiffBlocks("old\n", "new\n") ?? [];
		renderDiff({ blocks });

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.querySelector("[data-diff-kind='removed']")?.textContent).toContain("old");
		expect(host.querySelector("[data-diff-kind='added']")?.textContent).toContain("new");
	});

	it("sanitizes markup on both sides", () => {
		const blocks = buildMarkdownDiffBlocks(
			"<script>alert(1)</script>gone\n",
			"<img src=\"x\" onerror=\"alert(2)\">stays\n",
		) ?? [];
		renderDiff({ blocks });

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.querySelector("script")).toBeNull();
		expect(host.querySelector("[onerror]")).toBeNull();
	});

	it("renders Mermaid fences inside changed blocks", async () => {
		const blocks = buildMarkdownDiffBlocks(
			"```mermaid\nflowchart LR\nA --> B\n```\n",
			"```mermaid\nflowchart LR\nA --> C\n```\n",
		) ?? [];
		renderDiff({ blocks });

		await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
		expect(screen.getAllByRole("img", { name: "Mermaid chart" })).toHaveLength(2);
		expect(screen.getAllByTestId("rendered-mermaid")).toHaveLength(2);
	});

	it("folds the untouched bulk of a long document away from the change", () => {
		const blocks = buildMarkdownDiffBlocks(longDocument(false), longDocument(true))!;
		renderDiff({ blocks });

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.textContent).toContain("paragraph ten, edited");
		// Three unchanged chunks are kept on each side; the rest of the file folds.
		expect(host.textContent).toContain("paragraph 9");
		expect(host.textContent).toContain("paragraph 11");
		expect(host.textContent).not.toContain("paragraph 0");
		expect(host.textContent).not.toContain("paragraph 19");
		expect(screen.getAllByTestId("markdown-diff-unfold")).toHaveLength(2);
	});

	it("names the section a fold sits in", () => {
		const blocks = buildMarkdownDiffBlocks(longDocument(false), longDocument(true))!;
		renderDiff({ blocks });

		// Everything after the change sits under "# Guide", the file's only heading.
		expect(screen.getAllByTestId("markdown-diff-unfold")[1].textContent).toContain("Guide");
	});

	it("unfolds a run in place when its row is clicked", () => {
		const blocks = buildMarkdownDiffBlocks(longDocument(false), longDocument(true))!;
		renderDiff({ blocks });

		fireEvent.click(screen.getAllByTestId("markdown-diff-unfold")[0]);

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.textContent).toContain("paragraph 0");
		expect(screen.getAllByTestId("markdown-diff-unfold")).toHaveLength(1);
	});

	it("keeps a commented unchanged block visible so revealing it still works", () => {
		const blocks = buildMarkdownDiffBlocks(longDocument(false), longDocument(true))!;
		const target = blocks.find(
			(block: MarkdownDiffBlock) => block.kind === "context" && block.source.includes("paragraph 0"),
		)!;
		renderDiff({
			blocks,
			commentedLines: { oldFile: new Set<number>(), newFile: new Set([target.startLine]) },
		});

		expect(screen.getByTestId("markdown-rich-diff").textContent).toContain("paragraph 0");
	});

	it("keeps a deleted-only paragraph visible with its context", () => {
		const before = Array.from({ length: 20 }, (_, index) => `paragraph ${index}`);
		const after = before.filter((_, index) => index !== 10);
		const blocks = buildMarkdownDiffBlocks(`${before.join("\n\n")}\n`, `${after.join("\n\n")}\n`)!;
		renderDiff({ blocks });

		const host = screen.getByTestId("markdown-rich-diff");
		// The deletion is the only change, so nothing but the removed block marks it.
		expect(host.querySelector("[data-diff-kind='removed']")?.textContent).toContain("paragraph 10");
		expect(host.querySelector("[data-diff-kind='added']")).toBeNull();
		expect(host.textContent).toContain("paragraph 9");
		expect(host.textContent).not.toContain("paragraph 0");
	});

	it("keeps two distant changes separate instead of merging their context", () => {
		const before = Array.from({ length: 40 }, (_, index) => `paragraph ${index}`);
		const after = before.map((text, index) =>
			index === 5 || index === 30 ? `${text}, edited` : text);
		const blocks = buildMarkdownDiffBlocks(`${before.join("\n\n")}\n`, `${after.join("\n\n")}\n`)!;
		renderDiff({ blocks });

		const host = screen.getByTestId("markdown-rich-diff");
		expect(host.textContent).toContain("paragraph 5, edited");
		expect(host.textContent).toContain("paragraph 30, edited");
		// The gap between the two changes and the trailing run each fold on their
		// own. The two paragraphs before the first change do not: a run that short
		// costs more as a fold row than as text.
		expect(screen.getAllByTestId("markdown-diff-unfold")).toHaveLength(2);
		expect(host.textContent).toContain("paragraph 0");
		expect(host.textContent).not.toContain("paragraph 20");
		expect(host.textContent).not.toContain("paragraph 39");
	});

	it("leaves a short document alone", () => {
		const blocks = buildMarkdownDiffBlocks("# Title\n\nold text\n", "# Title\n\nnew text\n")!;
		renderDiff({ blocks });

		expect(screen.queryByTestId("markdown-diff-unfold")).toBeNull();
	});
});
