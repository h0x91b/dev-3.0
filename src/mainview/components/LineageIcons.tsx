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

/** Start after another task completes: a finished node, then a start arrow. */
export function StartAfterCompletedIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="7" cy="12" r="4.5" />
			<path d="M5 12.2l1.4 1.4L9 11" />
			<path d="M13.5 12h2.5" />
			<path d="M17.5 8.5l4 3.5-4 3.5z" fill="currentColor" fillOpacity="0.25" />
		</svg>
	);
}

/** Blocked by a dependency: two chained links. */
export function DependencyBlockedIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
			<path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
		</svg>
	);
}

/** Every dependency is done: a check in a circle. */
export function DependencyReadyIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="12" cy="12" r="8.5" />
			<path d="M8.5 12.3l2.4 2.4 4.6-5" />
		</svg>
	);
}

/** Start after another task's pull request merges: a merge branch. */
export function StartAfterMergedIcon({ className }: { className?: string }) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="6" cy="5" r="2.2" />
			<circle cx="6" cy="19" r="2.2" />
			<circle cx="18" cy="15" r="2.2" fill="currentColor" fillOpacity="0.25" />
			<path d="M6 7.2v9.6" />
			<path d="M6 7.2c0 4.5 3.5 7.8 9.8 7.8" />
		</svg>
	);
}
