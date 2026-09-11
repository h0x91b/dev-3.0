import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export interface RevealGeometry {
	/** Scroll container's viewport edges, in client coordinates. */
	containerTop: number;
	containerBottom: number;
	/** Selected row's edges, in client coordinates. */
	rowTop: number;
	rowBottom: number;
	/** Sticky tier header covering the container's top edge. */
	headerHeight: number;
	scrollTop: number;
}

/**
 * Smallest scrollTop that brings the row fully into view, or null when it
 * already is. Above the fold the row clears the sticky tier header; below it
 * the row's bottom meets the container's. A row taller than the viewport is
 * aligned to its top — the title lives there.
 */
export function computeRevealScrollTop(g: RevealGeometry): number | null {
	const visibleTop = g.containerTop + g.headerHeight;
	if (g.rowTop < visibleTop) return g.scrollTop - (visibleTop - g.rowTop);
	if (g.rowBottom > g.containerBottom) {
		const delta = Math.min(g.rowBottom - g.containerBottom, g.rowTop - visibleTop);
		return delta > 0 ? g.scrollTop + delta : null;
	}
	return null;
}

/** An unfinished reveal keeps trying for ~60 frames (1s), then gives up. */
const RETRY_FRAMES = 60;

/** The user's own hands on the list — these call the whole reveal off. */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function measure(container: HTMLElement, selectedTaskId: string): RevealGeometry | null {
	const row = container.querySelector(`[data-task-id="${selectedTaskId}"]`);
	if (!row) return null;
	const containerRect = container.getBoundingClientRect();
	const rowRect = row.getBoundingClientRect();
	const header = row.closest("[data-sidebar-tier]")?.querySelector("[data-sidebar-tier-header]");
	return {
		containerTop: containerRect.top,
		containerBottom: containerRect.bottom,
		rowTop: rowRect.top,
		rowBottom: rowRect.bottom,
		headerHeight: header ? header.getBoundingClientRect().height : 0,
		scrollTop: container.scrollTop,
	};
}

/**
 * Scrolls the sidebar just enough to reveal the selected row again after a
 * status change reorders the list. It moves the container's own scrollTop —
 * never `scrollIntoView`, which would also scroll the page and the terminal —
 * and never touches focus.
 *
 * Two gates keep it out of the user's way: it runs only when `positionKey`
 * changes, so background task updates leave the scroll alone, and a row the
 * user had already scrolled away from stays where it is. Picking another task
 * always reveals it, wherever the list happens to sit.
 */
export function useRevealSelectedRow(
	containerRef: RefObject<HTMLElement | null>,
	selectedTaskId: string | null,
	positionKey: string | null,
) {
	// Whether the selected row was on screen before this update — the difference
	// between "it flew out from under the user" and "the user scrolled away".
	const wasVisibleRef = useRef(true);
	const lastSelectedRef = useRef<string | null>(null);
	const retryRef = useRef<number | null>(null);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!positionKey || !selectedTaskId || !container) return;
		const geometry = measure(container, selectedTaskId);
		if (!geometry) return;
		const reselected = lastSelectedRef.current !== selectedTaskId;
		lastSelectedRef.current = selectedTaskId;
		const needed = computeRevealScrollTop(geometry);
		const allowed = reselected || wasVisibleRef.current;
		let stop = (_byUser = false) => {};
		if (needed !== null && allowed) {
			// One pass is not enough: the rest of the list is often still laying
			// out, so the browser clamps the scroll short and then shifts the row
			// again. Follow it frame by frame until it is fully in view — and drop
			// everything the moment the user touches the list themselves.
			let framesLeft = RETRY_FRAMES;
			const onTakeover = () => stop(true);
			stop = (byUser = false) => {
				if (retryRef.current !== null) cancelAnimationFrame(retryRef.current);
				retryRef.current = null;
				for (const event of TAKEOVER_EVENTS) container.removeEventListener(event, onTakeover);
				// Our own scrolling fires scroll events mid-flight, so the tracker
				// below may have recorded a half-scrolled frame. Only the user's own
				// takeover decides that the row was left behind on purpose.
				const g = byUser ? measure(container, selectedTaskId) : null;
				wasVisibleRef.current = g ? computeRevealScrollTop(g) === null : true;
			};
			const step = () => {
				const g = measure(container, selectedTaskId);
				const target = g ? computeRevealScrollTop(g) : null;
				if (target === null || --framesLeft <= 0) {
					stop();
					return;
				}
				container.scrollTop = target;
				retryRef.current = requestAnimationFrame(step);
			};
			for (const event of TAKEOVER_EVENTS) container.addEventListener(event, onTakeover, { passive: true });
			wasVisibleRef.current = true;
			step();
		} else {
			wasVisibleRef.current = needed === null;
		}
		return () => stop();
		// containerRef is a stable ref; the position key is the only trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [positionKey]);

	// Manual scrolling is what tells us the user left the selected row behind.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		function onScroll() {
			if (!container || !selectedTaskId) return;
			const geometry = measure(container, selectedTaskId);
			if (geometry) wasVisibleRef.current = computeRevealScrollTop(geometry) === null;
		}
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => container.removeEventListener("scroll", onScroll);
	}, [containerRef, selectedTaskId]);
}
