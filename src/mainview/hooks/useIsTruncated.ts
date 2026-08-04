import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tracks whether a single-line element is actually clipped by `truncate`.
 *
 * Exists so a tooltip can reveal the full string only when it is hidden — a
 * tooltip that repeats text already fully on screen is noise. Re-measures on
 * element resize, so it follows column-width and viewport changes.
 *
 *   const [ref, truncated] = useIsTruncated<HTMLSpanElement>(label);
 *   <Tooltip content={label} disabled={!truncated}><span ref={ref} …/></Tooltip>
 */
export function useIsTruncated<T extends HTMLElement>(
	/** Re-measure when the rendered text changes, not just its box. */
	text?: string,
): [(node: T | null) => void, boolean] {
	const [truncated, setTruncated] = useState(false);
	const nodeRef = useRef<T | null>(null);

	const measure = useCallback(() => {
		const el = nodeRef.current;
		// +1px: sub-pixel layout rounding otherwise reports a 1px overflow on
		// strings that visually fit.
		setTruncated(!!el && el.scrollWidth > el.clientWidth + 1);
	}, []);

	const ref = useCallback(
		(node: T | null) => {
			nodeRef.current = node;
			measure();
		},
		[measure],
	);

	useEffect(() => {
		measure();
		const el = nodeRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [measure, text]);

	return [ref, truncated];
}
