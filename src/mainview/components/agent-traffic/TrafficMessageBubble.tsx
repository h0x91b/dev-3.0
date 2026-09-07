import { useLayoutEffect, useRef, useState } from "react";

export default function TrafficMessageBubble({ subject, anchor, width, height, failed }: {
	subject: string;
	anchor: { x: number; y: number };
	width: number;
	height: number;
	failed: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 290, height: 60 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			if (element.offsetWidth && element.offsetHeight)
				setSize({ width: element.offsetWidth, height: element.offsetHeight });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [subject, width]);
	const left = Math.max(size.width / 2 + 12, Math.min(width - size.width / 2 - 12, anchor.x));
	const below = anchor.y < size.height + 34;
	const top = anchor.y + (below ? 22 : -22);
	const tailX = Math.max(18, Math.min(size.width - 18, anchor.x - left + size.width / 2));
	const tipX = anchor.x - left + size.width / 2 - tailX + 10;
	return (
		<div ref={ref} className={`traffic-edge-subject ${failed ? "is-failed" : ""} ${below ? "is-below" : ""}`}
			style={{ left, top, maxWidth: Math.max(80, width - 24), visibility: anchor.x < 0 || anchor.x > width || anchor.y < 0 || anchor.y > height ? "hidden" : undefined }}>
			<strong className="streamer-private">{subject}</strong>
			<svg className="traffic-message-tail" width="20" height="24" viewBox="0 -2 20 24"
				style={{ left: tailX - 10 }} aria-hidden="true">
				<path d={`M0 -2 C4 2 ${tipX - 5} 14 ${tipX - 1.5} 20 Q${tipX} 24 ${tipX + 1.5} 20 C${tipX + 5} 14 16 2 20 -2`} />
			</svg>
		</div>
	);
}
