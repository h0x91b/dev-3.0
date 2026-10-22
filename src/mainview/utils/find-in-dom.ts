/**
 * Range-based find over whatever is rendered inside a container — used by the
 * file preview, where the same query has to hit both the raw code listing and
 * React-rendered Markdown. Highlighting goes through the CSS Custom Highlight
 * API precisely because it paints without touching the DOM: wrapping matches in
 * elements would fight the Markdown renderer, which owns those nodes.
 */

/** CSS Highlight registry names a find paints under; two finds on screen must not share a pair. */
export interface FindHighlightNames {
	rest: string;
	active: string;
}

const DEFAULT_HIGHLIGHT_NAMES: FindHighlightNames = { rest: "dev3-find", active: "dev3-find-active" };

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

/**
 * Like collectFindRanges, but matches across text nodes: syntax highlighting
 * splits a code line into many spans, so a query with a space or punctuation
 * spans several nodes. Text under `skipSelector` (e.g. a diff's +/- gutter) is left out.
 */
export function collectJoinedFindRanges(
	root: HTMLElement | null,
	query: string,
	skipSelector: string,
	limit = MAX_FIND_MATCHES,
): Range[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!root || !needle) return [];

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!node.nodeValue || !parent || SKIPPED_TAGS.test(parent.tagName) || parent.closest(skipSelector)) {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes: Array<{ node: Node; start: number }> = [];
	let joined = "";
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push({ node, start: joined.length });
		joined += (node.nodeValue ?? "").toLocaleLowerCase();
	}

	const ranges: Range[] = [];
	let first = 0;
	for (let at = joined.indexOf(needle); at >= 0 && ranges.length < limit; at = joined.indexOf(needle, at + needle.length)) {
		const end = at + needle.length;
		while (first + 1 < nodes.length && nodes[first + 1].start <= at) first += 1;
		let last = first;
		while (last + 1 < nodes.length && nodes[last + 1].start < end) last += 1;
		const range = root.ownerDocument.createRange();
		range.setStart(nodes[first].node, at - nodes[first].start);
		range.setEnd(nodes[last].node, end - nodes[last].start);
		ranges.push(range);
	}
	return ranges;
}

function selectRange(range: Range | null): void {
	const selection = globalThis.getSelection?.();
	if (!selection) return;
	selection.removeAllRanges();
	if (range) selection.addRange(range);
}

export function clearFindHighlights(names: FindHighlightNames = DEFAULT_HIGHLIGHT_NAMES): void {
	const registry = highlightRegistry();
	if (!registry) {
		selectRange(null);
		return;
	}
	registry.delete(names.rest);
	registry.delete(names.active);
}

export function paintFindRanges(
	ranges: readonly Range[],
	activeIndex: number,
	names: FindHighlightNames = DEFAULT_HIGHLIGHT_NAMES,
): void {
	const registry = highlightRegistry();
	// No Custom Highlight API (older WebKit): fall back to selecting the active
	// match, so stepping is still visible even without the other matches tinted.
	if (!registry) {
		selectRange(ranges[activeIndex] ?? null);
		return;
	}
	clearFindHighlights(names);
	if (ranges.length === 0) return;

	const HighlightCtor = (globalThis as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
	const rest = ranges.filter((_, index) => index !== activeIndex);
	if (rest.length > 0) registry.set(names.rest, new HighlightCtor(...rest));
	const active = ranges[activeIndex];
	if (active) registry.set(names.active, new HighlightCtor(active));
}

export function scrollRangeIntoView(range: Range | undefined): void {
	const target = range?.startContainer.parentElement;
	target?.scrollIntoView({ block: "center", inline: "nearest" });
}
