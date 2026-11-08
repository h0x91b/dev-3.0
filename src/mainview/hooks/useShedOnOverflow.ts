import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * How many optional items a one-line row can keep without overflowing: starts
 * at `levels` and sheds one per layout pass while the row is wider than its box.
 * A wider box or a new `resetKey` (different content) starts from the top again.
 */
export function useShedOnOverflow(ref: RefObject<HTMLElement | null>, levels: number, resetKey: string): number {
	const [level, setLevel] = useState(levels);
	const widthRef = useRef(0);

	useLayoutEffect(() => {
		setLevel(levels);
	}, [resetKey, levels]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (el && level > 0 && el.scrollWidth > el.clientWidth + 1) setLevel(level - 1);
	});

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		widthRef.current = el.clientWidth;
		const observer = new ResizeObserver(() => {
			const width = el.clientWidth;
			if (width > widthRef.current) setLevel(levels);
			else if (el.scrollWidth > el.clientWidth + 1) setLevel((current) => Math.max(0, current - 1));
			widthRef.current = width;
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref, levels]);

	return level;
}
