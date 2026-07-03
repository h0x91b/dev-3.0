import type { SVGProps } from "react";

/**
 * Hand-drawn tmux glyphs shared by the pane toolbar (TaskTmuxControls), the
 * layout dropdown, the mobile pane carousel (MobilePaneCarousel), and the
 * un-zoom badge (PaneZoomBadge).
 *
 * Every icon carries `tmx-*` animation hooks: when a `.tmux-anim` ancestor
 * (the button / menu row) is hovered, pure-CSS keyframes in index.css act out
 * the operation the icon triggers — the split saws its divider across, the
 * zoomed pane inflates, the closed pane shudders and blinks out, and so on.
 * Idle rendering is pixel-identical to the original static glyphs.
 */

interface TmuxIconProps {
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

export function SplitHIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="13" width="18" height="6.25" rx="1" fill="currentColor" stroke="none" opacity="0" className="text-success tmx-sh-half" />
			<line x1="2" y1="12" x2="22" y2="12" strokeDasharray="4 3" className="tmx-sh-div" />
			<path d="M12 15 L12 19 M10 17 L14 17" className="text-success tmx tmx-sh-plus" />
		</svg>
	);
}

export function SplitVIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="13" y="5" width="8" height="14" rx="1" fill="currentColor" stroke="none" opacity="0" className="text-success tmx-sv-half" />
			<line x1="12" y1="4" x2="12" y2="20" strokeDasharray="4 3" className="tmx-sv-div" />
			<path d="M16 12 L20 12 M18 10 L18 14" className="text-success tmx tmx-sv-plus" />
		</svg>
	);
}

export function CycleLayoutIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="10" width="8" height="6" rx="1" className="tmx tmx-cy-left" />
			<rect x="14" y="10" width="8" height="6" rx="1" className="tmx tmx-cy-right" />
			<g className="text-success tmx tmx-cy-orbit">
				<path d="M 6 8 C 8 3, 16 3, 18 8" />
				<path d="M 15 6 L 18 8 L 21 6" />
				<path d="M 18 18 C 16 23, 8 23, 6 18" />
				<path d="M 9 20 L 6 18 L 3 20" />
			</g>
		</svg>
	);
}

export function ZoomPaneIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="4" y="6" width="16" height="12" rx="1" className="tmx tmx-z-rect" />
			<path d="M2 5 L2 2 L5 2" className="tmx tmx-z-tl" />
			<path d="M19 2 L22 2 L22 5" className="tmx tmx-z-tr" />
			<path d="M22 19 L22 22 L19 22" className="tmx tmx-z-br" />
			<path d="M5 22 L2 22 L2 19" className="tmx tmx-z-bl" />
			<path d="M6 6 L2 2" pathLength={1} className="tmx-draw tmx-z-diag" />
			<path d="M18 6 L22 2" pathLength={1} className="tmx-draw tmx-z-diag" />
			<path d="M18 18 L22 22" pathLength={1} className="tmx-draw tmx-z-diag" />
			<path d="M6 18 L2 22" pathLength={1} className="tmx-draw tmx-z-diag" />
		</svg>
	);
}

export function ClosePaneIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="tmx tmx-k-shake">
				<g className="tmx-k-die">
					<rect x="2" y="4" width="20" height="16" rx="2" />
					<path d="M9 9 L15 15" pathLength={1} className="tmx-draw tmx-k-x1" />
					<path d="M15 9 L9 15" pathLength={1} className="tmx-draw tmx-k-x2" />
				</g>
			</g>
		</svg>
	);
}

export function TmuxHintsIcon({ className }: TmuxIconProps) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth=".9" opacity="0" className="tmx tmx-i-ring" />
			<path
				className="tmx tmx-i-glyph"
				d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zM7.25 5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5z"
			/>
		</svg>
	);
}

export function LayoutTiledIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="5" width="8" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-lt-q1" />
			<rect x="13" y="5" width="8" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-lt-q2" />
			<rect x="3" y="13" width="8" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-lt-q3" />
			<rect x="13" y="13" width="8" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-lt-q4" />
			<line x1="12" y1="4" x2="12" y2="20" pathLength={1} className="tmx-draw tmx-lt-v" />
			<line x1="2" y1="12" x2="22" y2="12" pathLength={1} className="tmx-draw tmx-lt-h" />
		</svg>
	);
}

export function LayoutEvenHIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="5" width="18" height="3.6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-eh-r1" />
			<rect x="3" y="10" width="18" height="3.9" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-eh-r2" />
			<rect x="3" y="15.4" width="18" height="3.6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-eh-r3" />
			<line x1="2" y1="9.33" x2="22" y2="9.33" pathLength={1} className="tmx-draw tmx-eh-l1" />
			<line x1="2" y1="14.66" x2="22" y2="14.66" pathLength={1} className="tmx-draw tmx-eh-l2" />
		</svg>
	);
}

export function LayoutEvenVIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="5" width="4.9" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-ev-c1" />
			<rect x="9.4" y="5" width="5.2" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-ev-c2" />
			<rect x="16" y="5" width="5" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-ev-c3" />
			<line x1="8.66" y1="4" x2="8.66" y2="20" pathLength={1} className="tmx-draw tmx-ev-l1" />
			<line x1="15.33" y1="4" x2="15.33" y2="20" pathLength={1} className="tmx-draw tmx-ev-l2" />
		</svg>
	);
}

export function LayoutMainHIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="5" width="18" height="7" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mh-main" />
			<rect x="3" y="14" width="8" height="5" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mh-sub" />
			<rect x="13" y="14" width="8" height="5" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mh-sub" />
			<line x1="2" y1="13" x2="22" y2="13" pathLength={1} className="tmx-draw tmx-mh-l1" />
			<line x1="12" y1="13" x2="12" y2="20" pathLength={1} className="tmx-draw tmx-mh-l2" />
		</svg>
	);
}

export function LayoutMainVIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<rect x="3" y="5" width="9" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mv-main" />
			<rect x="14" y="5" width="7" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mv-sub" />
			<rect x="14" y="13" width="7" height="6" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mv-sub" />
			<line x1="13" y1="4" x2="13" y2="20" pathLength={1} className="tmx-draw tmx-mv-l1" />
			<line x1="13" y1="12" x2="22" y2="12" pathLength={1} className="tmx-draw tmx-mv-l2" />
		</svg>
	);
}

export function NewWindowIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="tmx tmx-nw-pop">
				<rect x="2" y="4" width="20" height="16" rx="2" />
				<rect x="3" y="10" width="18" height="9" fill="currentColor" stroke="none" opacity="0" className="text-success tmx-nw-bar" />
				<line x1="2" y1="9" x2="22" y2="9" pathLength={1} className="tmx-draw tmx-nw-tab" />
				<path d="M12 12.5 L12 17.5 M9.5 15 L14.5 15" className="tmx tmx-nw-plus" />
			</g>
		</svg>
	);
}

export function ManagePanesIcon({ className }: TmuxIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<rect x="4" y="5" width="7.25" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mg-left" />
			<rect x="12.75" y="5" width="7.25" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mg-right" />
			<rect x="4" y="5" width="7.25" height="14" fill="currentColor" stroke="none" opacity="0" className="text-accent tmx-mg-back" />
			<line x1="12" y1="4" x2="12" y2="20" pathLength={1} className="tmx-draw tmx-mg-line" />
		</svg>
	);
}
