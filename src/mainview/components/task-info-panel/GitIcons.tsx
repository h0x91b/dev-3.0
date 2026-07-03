import type { SVGProps } from "react";

/**
 * Hand-drawn git-action glyphs shared by the task info panel git row
 * (TaskGitActions) and the diff include-tests toggle (TaskInfoPanel).
 *
 * Every icon carries `gtx-*` animation hooks: when a `.git-anim` ancestor
 * (the button / toggle) is hovered, pure-CSS keyframes in index.css act out
 * the operation the icon triggers — the diff types its added line and blinks
 * the removed one, the rebase commit rides the rail to the tip, the push arrow
 * launches into the cloud, the PR curve draws over and the sparkle twinkles,
 * the auto-merge bolt strikes, the merge commit lands, the tests flask boils.
 * Idle rendering is pixel-identical to the static glyph.
 */

interface GitIconProps {
	className?: string;
}

function svgBase(className?: string): SVGProps<SVGSVGElement> {
	return {
		className,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
	};
}

// 1B — Show Diff (unified): + line types in, − line struck out.
export function ShowDiffIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<path d="M7 7.2 L7 10.8 M5.2 9 L8.8 9" className="text-success gtx gtx-gd-plus" />
			<line x1="11.5" y1="9" x2="18.5" y2="9" pathLength={1} className="text-success gtx-draw gtx-gd-add" />
			<g className="gtx-gd-del">
				<path d="M5.2 15 L8.8 15" className="text-danger" />
				<line x1="11.5" y1="15" x2="18.5" y2="15" className="text-danger" />
			</g>
		</svg>
	);
}

// 2A — Rebase (replant): the commit rides the dashed rail to the tip.
export function RebaseIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="6" cy="5" r="1.9" className="gtx gtx-gr-land" />
			<line x1="6" y1="7.1" x2="6" y2="16.9" />
			<circle cx="6" cy="19" r="1.9" />
			<circle cx="17.5" cy="17" r="1.9" className="text-success gtx gtx-gr-dot" />
			<path d="M17.5 14.9 C17.5 10.2 15.2 7 11 5.6" strokeDasharray="2.4 2.2" className="text-success gtx-gr-ants" />
			<path d="M13.6 3.4 L10.6 5.5 L13.2 8" className="text-success" />
		</svg>
	);
}

// 3A — Push (cloud): the arrow launches up into the cloud, cloud gulps.
export function PushIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M17.8 16.2 A4.2 4.2 0 0 0 17.2 8.1 A6.4 6.4 0 0 0 4.9 9.9 A3.9 3.9 0 0 0 5.4 16.1" className="gtx gtx-gp-cloud" />
			<path d="M12 21 L12 11.5 M8.6 14.9 L12 11.5 L15.4 14.9" className="text-success gtx gtx-gp-arrow" />
		</svg>
	);
}

// 4B — Create PR (sparkle): branch curve draws over, sparkle twinkles.
export function CreatePRIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="6.5" cy="6" r="1.9" />
			<line x1="6.5" y1="8.1" x2="6.5" y2="16.4" />
			<circle cx="6.5" cy="18.5" r="1.9" />
			<path d="M10.5 6 H11.5 A4 4 0 0 1 15.5 10 V16.4" pathLength={1} className="gtx-draw gtx-gc-curve" />
			<circle cx="15.5" cy="18.5" r="1.9" className="gtx gtx-gc-dot" />
			<path
				d="M19.7 2.6 C20.1 4.5 20.8 5.2 22.7 5.6 C20.8 6 20.1 6.7 19.7 8.6 C19.3 6.7 18.6 6 16.7 5.6 C18.6 5.2 19.3 4.5 19.7 2.6 Z"
				fill="currentColor"
				stroke="none"
				className="text-success gtx gtx-gc-spark"
			/>
		</svg>
	);
}

// 5A — PR + auto-merge (lightning): curve draws, the bolt strikes.
export function AutoMergeIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="6" cy="5.5" r="1.9" />
			<line x1="6" y1="7.6" x2="6" y2="16.4" />
			<circle cx="6" cy="18.5" r="1.9" />
			<path d="M10 5.5 H11.5 A4.5 4.5 0 0 1 16 10 V10.5" pathLength={1} className="gtx-draw gtx-gl-curve" />
			<path
				d="M17.8 10 L13.8 15.6 H16.4 L14.9 20.8 L19.9 14.4 H17 L18.9 10 Z"
				fill="currentColor"
				stroke="none"
				className="text-success gtx gtx-gl-bolt"
			/>
		</svg>
	);
}

// 6A — Merge (classic): branch flows into the base, merge commit lands.
export function MergeIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<circle cx="7" cy="5.5" r="1.9" />
			<line x1="7" y1="7.6" x2="7" y2="16.4" />
			<circle cx="7" cy="18.5" r="1.9" />
			<path d="M7.2 7.9 C7.6 11.6 11 13.7 14.8 14" pathLength={1} className="gtx-draw gtx-gm-curve" />
			<circle cx="17" cy="14" r="1.9" className="text-success gtx gtx-gm-dot" />
		</svg>
	);
}

// 7A — Include tests toggle (boiling flask): liquid sloshes, bubbles rise.
export function IncludeTestsIcon({ className }: GitIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M8.8 3.2 H15.2" />
			<path d="M10 3.2 V9 L5.6 17.6 A1.8 1.8 0 0 0 7.2 20.3 H16.8 A1.8 1.8 0 0 0 18.4 17.6 L14 9 V3.2" />
			<g className="gtx gtx-tf-liquid">
				<path d="M7.7 14.3 L6.1 17.7 A1.1 1.1 0 0 0 7.1 19.3 H16.9 A1.1 1.1 0 0 0 17.9 17.7 L16.3 14.3 Z" fill="currentColor" stroke="none" className="text-success" opacity="0.3" />
				<path d="M7.7 14.3 H16.3" className="text-success" />
			</g>
			<circle cx="10.6" cy="17" r="0.9" fill="currentColor" stroke="none" className="text-success gtx gtx-tf-b1" />
			<circle cx="13.6" cy="17.8" r="0.7" fill="currentColor" stroke="none" className="text-success gtx gtx-tf-b2" />
		</svg>
	);
}
