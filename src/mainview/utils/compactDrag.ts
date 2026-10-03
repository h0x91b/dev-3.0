import { flushSync } from "react-dom";

function scrollParentOf(element: HTMLElement): Element | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
	}
	return document.scrollingElement;
}

/**
 * Collapses a list for a drag one task AFTER `dragstart`, never inside it.
 * Restructuring the DOM during `dragstart` makes Chromium end the drag at once
 * and WebKit turn the gesture into a text selection. Once collapsed, the list
 * scrolls by however far `anchor` moved, so the dragged row stays under the
 * pointer. Returns a cancel for a drag that ends before the collapse lands.
 */
export function scheduleCompactDrag(anchor: HTMLElement, collapse: () => void): () => void {
	const timer = window.setTimeout(() => {
		const before = anchor.getBoundingClientRect().top;
		flushSync(collapse);
		const shift = anchor.getBoundingClientRect().top - before;
		if (shift !== 0) scrollParentOf(anchor)?.scrollBy(0, shift);
	}, 0);
	return () => window.clearTimeout(timer);
}
