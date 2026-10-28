import type { SVGProps } from "react";

/**
 * Task lineage glyphs (see Task.origin): same stroke style as TaskIcons, static —
 * they sit in the card's identity row, which never animates.
 */
function svgBase(className?: string): SVGProps<SVGSVGElement> {
	return {
		className,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.9,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
	};
}

/** Created by another task: this node hangs off a parent above it. */
export function ParentTaskIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3.5" y="3.5" width="7" height="6" rx="1.6" />
			<path d="M7 9.5v4.5a3 3 0 0 0 3 3h3.5" />
			<rect x="13.5" y="14" width="7" height="6" rx="1.6" fill="currentColor" fillOpacity="0.25" />
		</svg>
	);
}

/** Created other tasks: one node fanning out to its children. */
export function ChildTasksIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3.5" y="9" width="6" height="6" rx="1.6" fill="currentColor" fillOpacity="0.25" />
			<path d="M9.5 12h2.5M12 6.5v11M12 6.5h2.5M12 17.5h2.5" />
			<rect x="14.5" y="3.5" width="6" height="6" rx="1.6" />
			<rect x="14.5" y="14.5" width="6" height="6" rx="1.6" />
		</svg>
	);
}
