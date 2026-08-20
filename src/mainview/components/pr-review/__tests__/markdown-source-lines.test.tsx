import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownDocument } from "../markdown";
import {
	MD_COMMENTED_CLASS,
	MD_LINE_END_ATTR,
	MD_LINE_START_ATTR,
	resolveMarkdownSelection,
} from "../markdown-source-lines";

const DOC = [
	"# Title", // 1
	"", // 2
	"First paragraph.", // 3
	"", // 4
	"Second paragraph", // 5
	"spanning two lines.", // 6
	"", // 7
	"- one", // 8
	"- two", // 9
].join("\n");

function stamped(container: HTMLElement): { text: string; start: string | null; end: string | null }[] {
	return [...container.querySelectorAll<HTMLElement>(`[${MD_LINE_START_ATTR}]`)].map((element) => ({
		text: element.textContent ?? "",
		start: element.getAttribute(MD_LINE_START_ATTR),
		end: element.getAttribute(MD_LINE_END_ATTR),
	}));
}

/** Selects the whole text of one stamped block, the way a drag over it would. */
function selectBlock(element: HTMLElement): Selection {
	const range = document.createRange();
	range.selectNodeContents(element);
	const selection = window.getSelection();
	if (!selection) throw new Error("no selection in this environment");
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

describe("markdown source line stamping", () => {
	it("stamps prose blocks with their source line range", () => {
		const { container } = render(<MarkdownDocument body={DOC} sourceLines={{ lineOffset: 1 }} />);
		const blocks = stamped(container);

		expect(blocks.find((block) => block.text === "Title")).toEqual({ text: "Title", start: "1", end: "1" });
		expect(blocks.find((block) => block.text === "First paragraph.")).toMatchObject({ start: "3", end: "3" });
		expect(blocks.find((block) => block.text.startsWith("Second paragraph"))).toMatchObject({
			start: "5",
			end: "6",
		});
		expect(blocks.find((block) => block.text === "one")).toMatchObject({ start: "8", end: "8" });
	});

	it("shifts the range by the block's line offset", () => {
		const { container } = render(
			<MarkdownDocument body={"Only line.\n"} sourceLines={{ lineOffset: 42 }} />,
		);
		expect(stamped(container)[0]).toMatchObject({ start: "42", end: "42" });
	});

	it("stamps nothing when no source lines are requested", () => {
		const { container } = render(<MarkdownDocument body={DOC} />);
		expect(stamped(container)).toEqual([]);
	});

	it("marks blocks whose lines carry a comment", () => {
		const { container } = render(
			<MarkdownDocument body={DOC} sourceLines={{ lineOffset: 1, commentedLines: new Set([6]) }} />,
		);
		const marked = [...container.querySelectorAll(`.${MD_COMMENTED_CLASS}`)];
		expect(marked).toHaveLength(1);
		expect(marked[0].textContent).toContain("Second paragraph");
	});
});

describe("resolveMarkdownSelection", () => {
	function renderDoc(body = DOC) {
		const { container } = render(<MarkdownDocument body={body} sourceLines={{ lineOffset: 1 }} />);
		const host = container.firstElementChild as HTMLElement;
		return { container, host };
	}

	it("maps a selection inside one block onto that block's lines", () => {
		const { container, host } = renderDoc();
		const block = [...container.querySelectorAll<HTMLElement>(`[${MD_LINE_START_ATTR}]`)]
			.find((element) => element.textContent?.startsWith("Second paragraph"))!;

		const anchor = resolveMarkdownSelection(host, selectBlock(block));

		expect(anchor).toMatchObject({ startLine: 5, endLine: 6, side: "newFile" });
		expect(anchor?.text).toContain("Second paragraph");
	});

	it("spans every block the selection touches", () => {
		const { container, host } = renderDoc();
		const blocks = [...container.querySelectorAll<HTMLElement>(`[${MD_LINE_START_ATTR}]`)];
		const first = blocks.find((element) => element.textContent === "First paragraph.")!;
		const last = blocks.find((element) => element.textContent === "two")!;

		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(last, last.childNodes.length);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);

		expect(resolveMarkdownSelection(host, selection)).toMatchObject({ startLine: 3, endLine: 9 });
	});

	it("returns null for a collapsed selection", () => {
		const { host } = renderDoc();
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		expect(resolveMarkdownSelection(host, selection)).toBeNull();
	});

	it("returns null when the selection sits outside the container", () => {
		const { host } = renderDoc();
		const outside = document.createElement("p");
		outside.textContent = "elsewhere";
		document.body.append(outside);

		expect(resolveMarkdownSelection(host, selectBlock(outside))).toBeNull();
		outside.remove();
	});

	it("returns null when the selection has no line-stamped ancestor", () => {
		const { container } = render(
			<MarkdownDocument body={"```js\nconst a = 1;\n```\n"} sourceLines={{ lineOffset: 1 }} />,
		);
		const host = container.firstElementChild as HTMLElement;
		const code = container.querySelector("code");
		expect(code).not.toBeNull();
		expect(resolveMarkdownSelection(host, selectBlock(code as HTMLElement))).toBeNull();
	});

	it("comments the old side when the selection sits in a removed rich-diff block", () => {
		const { container } = render(
			<div data-diff-kind="removed">
				<MarkdownDocument body={"Gone text."} sourceLines={{ lineOffset: 12 }} />
			</div>,
		);
		const host = container.firstElementChild as HTMLElement;
		const block = container.querySelector<HTMLElement>(`[${MD_LINE_START_ATTR}]`)!;

		expect(resolveMarkdownSelection(host, selectBlock(block))).toMatchObject({
			startLine: 12,
			side: "oldFile",
		});
	});
});
