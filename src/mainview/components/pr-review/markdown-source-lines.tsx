import { createElement, type ComponentProps } from "react";
import type { Components } from "streamdown";

export const MD_LINE_START_ATTR = "data-md-line-start";
export const MD_LINE_END_ATTR = "data-md-line-end";
export const MD_COMMENTED_CLASS = "dev3-md-commented";

/**
 * Prose blocks that carry their source line range. `pre` and `table` are
 * deliberately absent: Streamdown owns those (code fences, table controls) and
 * overriding them would replace working components with bare tags.
 */
const LINE_STAMPED_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li"] as const;

type StampedTag = (typeof LINE_STAMPED_TAGS)[number];

export interface SourceLineRange {
	/** 1-based first line of the range in the file the markdown came from. */
	startLine: number;
	/** 1-based last line, inclusive. */
	endLine: number;
}

/** Minimal shape of the hast node react-markdown hands to a component override. */
interface PositionedNode {
	position?: { start: { line: number }; end: { line: number } };
}

/**
 * Source lines of a rendered block, shifted into file coordinates.
 * `lineOffset` is the 1-based file line the rendered source starts on, so a
 * whole-document render passes 1 and a rich-diff chunk passes its own start.
 */
function nodeLines(node: unknown, lineOffset: number): SourceLineRange | null {
	const position = (node as PositionedNode | undefined)?.position;
	if (!position) return null;
	const startLine = position.start.line + lineOffset - 1;
	const endLine = Math.max(startLine, position.end.line + lineOffset - 1);
	return { startLine, endLine };
}

function rangeIsCommented(range: SourceLineRange, commentedLines: ReadonlySet<number>): boolean {
	for (let line = range.startLine; line <= range.endLine; line++) {
		if (commentedLines.has(line)) return true;
	}
	return false;
}

/**
 * Component overrides that stamp every prose block with its source line range,
 * so a text selection in the rendered preview can be mapped back onto the file
 * and reuse the line-anchored review comments.
 */
export function createSourceLineComponents(
	lineOffset: number,
	commentedLines?: ReadonlySet<number> | null,
): Partial<Components> {
	const components: Record<string, unknown> = {};
	for (const tag of LINE_STAMPED_TAGS) {
		components[tag] = ({ node, className, ...props }: ComponentProps<StampedTag> & { node?: unknown }) => {
			const range = nodeLines(node, lineOffset);
			const commented = range && commentedLines?.size ? rangeIsCommented(range, commentedLines) : false;
			return createElement(tag, {
				...props,
				className: commented ? `${className ? `${className} ` : ""}${MD_COMMENTED_CLASS}` : className,
				...(range
					? { [MD_LINE_START_ATTR]: range.startLine, [MD_LINE_END_ATTR]: range.endLine }
					: {}),
			});
		};
	}
	return components as Partial<Components>;
}

function readStampedLines(element: HTMLElement): SourceLineRange | null {
	const start = Number(element.getAttribute(MD_LINE_START_ATTR));
	const end = Number(element.getAttribute(MD_LINE_END_ATTR));
	if (!Number.isFinite(start) || start <= 0) return null;
	return { startLine: start, endLine: Number.isFinite(end) && end >= start ? end : start };
}

/** Nearest line-stamped ancestor of a selection endpoint, bounded by `container`. */
function closestStampedElement(node: Node | null, container: HTMLElement): HTMLElement | null {
	let current: Node | null = node;
	while (current && current !== container.parentNode) {
		if (current instanceof HTMLElement && current.hasAttribute(MD_LINE_START_ATTR)) {
			return container.contains(current) ? current : null;
		}
		current = current.parentNode;
	}
	return null;
}

export type MarkdownDiffSide = "oldFile" | "newFile";

export interface MarkdownSelectionAnchor extends SourceLineRange {
	side: MarkdownDiffSide;
	/** The selected text, trimmed — quoted back in the composer. */
	text: string;
}

/**
 * A `removed` rich-diff block only exists in the old file, so a selection
 * inside it comments the old side; unchanged and added blocks are the new file.
 */
function sideForElement(element: HTMLElement, container: HTMLElement): MarkdownDiffSide {
	let current: HTMLElement | null = element;
	while (current && container.contains(current)) {
		const kind = current.getAttribute("data-diff-kind");
		if (kind) return kind === "removed" ? "oldFile" : "newFile";
		current = current.parentElement;
	}
	return "newFile";
}

/**
 * Maps a live text selection inside a rendered markdown preview back onto a
 * source line range. Returns null when the selection is empty, escapes the
 * container, or lands somewhere with no source position (a code fence, a
 * mermaid diagram, an image) — the caller then offers no comment affordance
 * rather than a dead one.
 */
export function resolveMarkdownSelection(
	container: HTMLElement,
	selection: Selection | null,
): MarkdownSelectionAnchor | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const text = selection.toString().trim();
	if (!text) return null;
	const range = selection.getRangeAt(0);
	if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

	const startElement = closestStampedElement(range.startContainer, container);
	const endElement = closestStampedElement(range.endContainer, container) ?? startElement;
	if (!startElement || !endElement) return null;
	const startLines = readStampedLines(startElement);
	const endLines = readStampedLines(endElement);
	if (!startLines || !endLines) return null;

	return {
		startLine: Math.min(startLines.startLine, endLines.startLine),
		endLine: Math.max(startLines.endLine, endLines.endLine),
		side: sideForElement(startElement, container),
		text,
	};
}

/** Scrolls the block that owns `line` into view and flashes it. */
export function revealMarkdownLine(container: HTMLElement, line: number): boolean {
	const blocks = container.querySelectorAll<HTMLElement>(`[${MD_LINE_START_ATTR}]`);
	for (const block of blocks) {
		const range = readStampedLines(block);
		if (range && line >= range.startLine && line <= range.endLine) {
			block.scrollIntoView({ block: "center", behavior: "smooth" });
			block.classList.remove("dev3-md-flash");
			// Reading offsetWidth restarts the animation when the same block is
			// revealed twice in a row.
			void block.offsetWidth;
			block.classList.add("dev3-md-flash");
			return true;
		}
	}
	return false;
}
