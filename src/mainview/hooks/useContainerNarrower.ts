import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Is the observed element narrower than `minWidthPx`?
 *
 * The viewport is the wrong ruler for a panel that does not own the window: the
 * dashboard sits inside app chrome, and a remote browser tab is not the desktop
 * window at all. What decides whether a rail fits is the width of the box the
 * rail lives in.
 *
 * Attach the returned ref to a box whose width does NOT depend on the answer —
 * the flex row that holds both panels, never the panel itself, or showing the
 * rail shrinks the measurement and hides it again.
 *
 * A measured width of 0 means "not laid out yet" (or a test environment with no
 * layout), never "narrow": the initial viewport hint stands until a real width
 * arrives.
 */
export function useContainerNarrower<T extends HTMLElement>(
	minWidthPx: number,
): [(node: T | null) => void, boolean] {
	const [narrow, setNarrow] = useState(() =>
		typeof window === "undefined" ? false : window.innerWidth < minWidthPx,
	);
	const nodeRef = useRef<T | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);

	const measure = useCallback(() => {
		const width = nodeRef.current?.getBoundingClientRect().width ?? 0;
		if (width === 0) return;
		setNarrow(width < minWidthPx);
	}, [minWidthPx]);

	const ref = useCallback(
		(node: T | null) => {
			nodeRef.current = node;
			// The node can arrive after the effect ran (a conditional container).
			if (node && observerRef.current) {
				observerRef.current.observe(node);
				measure();
			}
		},
		[measure],
	);

	useLayoutEffect(() => {
		measure();
		if (typeof ResizeObserver === "undefined") {
			// No observer (older engine): the window is the only signal left.
			const onResize = () => measure();
			window.addEventListener("resize", onResize);
			return () => window.removeEventListener("resize", onResize);
		}
		const observer = new ResizeObserver(measure);
		observerRef.current = observer;
		if (nodeRef.current) observer.observe(nodeRef.current);
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, [measure]);

	return [ref, narrow];
}
