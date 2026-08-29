/**
 * Gives a plain mouse wheel a way into horizontal-only scroll containers.
 *
 * A mouse has no horizontal axis — ever. Chromium does not translate a vertical
 * wheel onto a container that can only scroll sideways, so surfaces like the
 * Kanban board were literally unreachable with a mouse while a trackpad's
 * two-finger swipe drove them fine.
 *
 * The rule is deliberately narrow: a vertical delta is handed to a horizontal
 * container ONLY when nothing between the pointer and the page can scroll
 * vertically. The moment a vertically-scrollable ancestor shows up it wins, so
 * wheeling over a wide code block inside the diff still scrolls the diff — we
 * never steal a wheel that already had a job.
 */

const SCROLLABLE_OVERFLOW = /auto|scroll|overlay/;

/**
 * Strips that want the wheel even though the page behind them scrolls: short,
 * unmistakably sideways rows where "move this strip" is the only thing a wheel
 * over them could sensibly mean. Prose containers are deliberately absent — a
 * code block inside a long diff must not pin the page.
 */
export const WHEEL_X_SELECTOR = '[data-wheel-x], .dev3-pr-md table, .dev3-pr-md [data-streamdown="mermaid"] [role="application"]';

function canScrollVertically(el: Element): boolean {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	return SCROLLABLE_OVERFLOW.test(getComputedStyle(el).overflowY);
}

function canScrollHorizontally(el: Element): boolean {
	if (el.scrollWidth <= el.clientWidth + 1) return false;
	return SCROLLABLE_OVERFLOW.test(getComputedStyle(el).overflowX);
}

/** Room left in the direction the wheel is asking for, in pixels. */
function roomFor(el: Element, delta: number): number {
	return delta > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
}

/**
 * The element a vertical wheel delta should scroll sideways, or `null` when the
 * event belongs to the browser (something can scroll vertically, nothing can
 * scroll horizontally, or the horizontal container is already at that edge).
 */
export function resolveHorizontalWheelTarget(start: Element | null, deltaY: number): HTMLElement | null {
	let candidate: HTMLElement | null = null;
	// The vertical check runs over the WHOLE chain, not just up to the first
	// horizontal container: a wide `<pre>` sitting inside the scrolling diff must
	// lose, or the page stops moving whenever the pointer rests on a code block.
	// An opted-in strip is the exception and wins on sight.
	for (let el: Element | null = start; el; el = el.parentElement) {
		if (el.matches(WHEEL_X_SELECTOR) && canScrollHorizontally(el)) {
			return roomFor(el, deltaY) > 0 ? (el as HTMLElement) : null;
		}
		if (canScrollVertically(el)) return null;
		if (!candidate && canScrollHorizontally(el)) candidate = el as HTMLElement;
	}
	if (!candidate) return null;
	return roomFor(candidate, deltaY) > 0 ? candidate : null;
}

/** Installs the bridge on `document`; returns the teardown. */
export function installHorizontalWheelBridge(doc: Document = document): () => void {
	function onWheel(e: WheelEvent) {
		// A horizontal delta already works, and ctrl+wheel is zoom, not scroll.
		if (e.deltaX !== 0 || e.deltaY === 0 || e.ctrlKey || e.defaultPrevented) return;
		const target = resolveHorizontalWheelTarget(e.target as Element | null, e.deltaY);
		if (!target) return;
		target.scrollLeft += e.deltaY;
		e.preventDefault();
	}
	doc.addEventListener("wheel", onWheel, { passive: false });
	return () => doc.removeEventListener("wheel", onWheel);
}
