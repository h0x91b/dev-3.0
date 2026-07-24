import { useEffect, useState, type RefObject } from "react";

/**
 * Observed pixel width of `ref`'s element, 0 until the first measurement.
 *
 * Viewport breakpoints (`useCompact` / `useNarrowViewport`) say nothing about a
 * panel that shares the viewport with the board — use this when a toolbar must
 * adapt to its own container.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		setWidth(el.getBoundingClientRect().width);
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);

	return width;
}
