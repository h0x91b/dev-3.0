/**
 * Range-based find over whatever is rendered inside a container — used by the
 * file preview, where the same query has to hit both the raw code listing and
 * React-rendered Markdown. Highlighting goes through the CSS Custom Highlight
 * API precisely because it paints without touching the DOM: wrapping matches in
 * elements would fight the Markdown renderer, which owns those nodes.
 */

const HIGHLIGHT_NAME = "dev3-find";
const ACTIVE_HIGHLIGHT_NAME = "dev3-find-active";

/** Hard stop so a one-character query in a huge file cannot lock up the frame. */
export const MAX_FIND_MATCHES = 2000;

const SKIPPED_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/;

interface HighlightRegistry {
	set(name: string, highlight: unknown): void;
	delete(name: string): void;
}

function highlightRegistry(): HighlightRegistry | null {
	const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
	const ctor = (globalThis as { Highlight?: unknown }).Highlight;
	return registry && typeof ctor === "function" ? registry : null;
}

export function collectFindRanges(root: HTMLElement | null, query: string): Range[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!root || !needle) return [];

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!node.nodeValue || !parent) return NodeFilter.FILTER_REJECT;
			if (SKIPPED_TAGS.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const ranges: Range[] = [];
	let node = walker.nextNode();
	while (node && ranges.length < MAX_FIND_MATCHES) {
		const text = (node.nodeValue ?? "").toLocaleLowerCase();
		let from = 0;
		while (ranges.length < MAX_FIND_MATCHES) {
			const at = text.indexOf(needle, from);
			if (at < 0) break;
			const range = root.ownerDocument.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			ranges.push(range);
			from = at + needle.length;
		}
		node = walker.nextNode();
	}
	return ranges;
}

function selectRange(range: Range | null): void {
	const selection = globalThis.getSelection?.();
	if (!selection) return;
	selection.removeAllRanges();
	if (range) selection.addRange(range);
}

export function clearFindHighlights(): void {
	const registry = highlightRegistry();
	if (!registry) {
		selectRange(null);
		return;
	}
	registry.delete(HIGHLIGHT_NAME);
	registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

export function paintFindRanges(ranges: readonly Range[], activeIndex: number): void {
	const registry = highlightRegistry();
	// No Custom Highlight API (older WebKit): fall back to selecting the active
	// match, so stepping is still visible even without the other matches tinted.
	if (!registry) {
		selectRange(ranges[activeIndex] ?? null);
		return;
	}
	clearFindHighlights();
	if (ranges.length === 0) return;

	const HighlightCtor = (globalThis as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
	const rest = ranges.filter((_, index) => index !== activeIndex);
	if (rest.length > 0) registry.set(HIGHLIGHT_NAME, new HighlightCtor(...rest));
	const active = ranges[activeIndex];
	if (active) registry.set(ACTIVE_HIGHLIGHT_NAME, new HighlightCtor(active));
}

export function scrollRangeIntoView(range: Range | undefined): void {
	const target = range?.startContainer.parentElement;
	target?.scrollIntoView({ block: "center", inline: "nearest" });
}
