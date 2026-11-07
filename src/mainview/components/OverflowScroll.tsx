import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Pixels per second the hidden tail scrolls into view at. */
const SCROLL_SPEED = 40;
const MIN_DURATION_S = 1.5;

/**
 * One line of text that fades out at the right edge when it does not fit, and
 * scrolls to reveal the rest while its row is hovered or keyboard-focused
 * (`.dev3-overflow-scroll` in index.css). While clipped, `fullText` is the tooltip.
 */
export function OverflowScroll({ children, fullText, className = "" }: { children: ReactNode; fullText?: string; className?: string }) {
	const outerRef = useRef<HTMLSpanElement>(null);
	const trackRef = useRef<HTMLSpanElement>(null);
	const [shift, setShift] = useState(0);

	useLayoutEffect(() => {
		const outer = outerRef.current;
		const track = trackRef.current;
		if (!outer || !track) return;
		const measure = () => setShift(Math.max(0, Math.ceil(track.scrollWidth - outer.clientWidth)));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(outer);
		observer.observe(track);
		return () => observer.disconnect();
	}, []);

	const overflowing = shift > 0;
	const style = overflowing
		? ({
				"--dev3-overflow-shift": `-${shift}px`,
				"--dev3-overflow-duration": `${Math.max(MIN_DURATION_S, shift / SCROLL_SPEED + 1)}s`,
			} as CSSProperties)
		: undefined;

	return (
		<span
			ref={outerRef}
			className={`dev3-overflow-scroll min-w-0 ${className}`}
			data-overflowing={overflowing || undefined}
			title={overflowing ? fullText : undefined}
			style={style}
		>
			<span ref={trackRef} className="dev3-overflow-scroll-track">
				{children}
			</span>
		</span>
	);
}
