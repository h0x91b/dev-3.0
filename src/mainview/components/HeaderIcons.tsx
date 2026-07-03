import type { SVGProps } from "react";

/**
 * Hand-drawn glyphs for the global header row (GlobalHeader), the prevent-sleep
 * toggle (PreventSleepToggle) and the git-pull button (GitPullButton). They
 * replace the old mix of Nerd Font glyphs and ad-hoc inline SVGs with a single
 * stroke style consistent with the tmux (TmuxIcons) and git (GitIcons) sets.
 *
 * Every icon carries `hdr-*` animation hooks: when a `.header-anim` ancestor
 * (the hosting button) is hovered, pure-CSS keyframes in index.css act out the
 * operation the icon triggers — chevrons lunge with a ghost echo, the home
 * prompt types itself, steam rises off the coffee, the lock shackle snaps shut,
 * the quick-shell bolt double-flashes, the terminal cursor blinks, the pull /
 * update arrows drop into and launch out of the cloud, the check draws itself,
 * the alert triangle quakes, QR marks scan in sequence, the gauge needle revs,
 * the octocat bows, the bug twitches its antennae, changelog lines write
 * themselves, kebab dots wave, the wrench ratchets, slider knobs seek a new mix.
 * Idle rendering is pixel-identical to the static icon.
 */

interface HeaderIconProps {
	className?: string;
}

function svgBase(className?: string, strokeWidth = 1.7): SVGProps<SVGSVGElement> {
	return {
		className,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
	};
}

// 01 — Back: the chevron lunges left, a ghost echo trails off.
export function BackIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className, 2)}>
			<path d="M14.5 5.5 8 12l6.5 6.5" className="hdr hdr-back" />
			<path d="M14.5 5.5 8 12l6.5 6.5" className="hdr hdr-back-ghost" opacity="0" />
		</svg>
	);
}

// 02 — Forward: mirror of Back.
export function ForwardIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className, 2)}>
			<path d="M9.5 5.5 16 12l-6.5 6.5" className="hdr hdr-fwd" />
			<path d="M9.5 5.5 16 12l-6.5 6.5" className="hdr hdr-fwd-ghost" opacity="0" />
		</svg>
	);
}

// 03 — Home breadcrumb: terminal box; the prompt types itself, cursor blinks.
export function HomeIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="4.5" width="18" height="15" rx="3" />
			<path d="m7.5 9.5 3 2.5-3 2.5" pathLength={1} className="hdr-draw hdr-home-prompt" />
			<path d="M12.5 14.5H16" className="hdr-home-cursor" />
		</svg>
	);
}

// 04 — Project dropdown: the chevron dips, a ghost drips down after it.
export function DropdownIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className, 2)}>
			<path d="m7 9.5 5 5 5-5" className="hdr hdr-dd" />
			<path d="m7 9.5 5 5 5-5" className="hdr hdr-dd-ghost" opacity="0" />
		</svg>
	);
}

// 05 — No Sleep (coffee, idle): fresh steam curls rise off the cup.
export function CoffeeIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M5.5 9.5H16v5.5a4 4 0 0 1-4 4H9.5a4 4 0 0 1-4-4z" />
			<path d="M16 10.5h1.25a2.5 2.5 0 0 1 0 5H16" />
			<path d="M9 6.5c0-1 .7-1 .7-2" className="hdr hdr-steam1" />
			<path d="M12.6 6.5c0-1 .7-1 .7-2" className="hdr hdr-steam2" />
		</svg>
	);
}

// 06 — No Sleep (locked): sleep tugs the shackle, it snaps shut, keyhole blinks.
export function LockIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="6.5" y="11" width="11" height="8.5" rx="2" />
			<path d="M9.5 11V8.5a2.5 2.5 0 0 1 5 0V11" className="hdr hdr-shackle" />
			<path d="M12 14.2v1.8" className="hdr-keyhole" />
		</svg>
	);
}

// 07 — Quick Shell: the bolt double-flashes, the prompt nudges forward.
export function QuickShellIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M14.5 3 6.5 12.5H12L10.5 21l8-9.5H13z" className="hdr hdr-bolt" />
			<path d="m3.5 14 2.8 2.8-2.8 2.7" className="hdr hdr-qs-prompt" />
		</svg>
	);
}

// 08 — Project Terminal: title-bar dots pulse, prompt types, cursor blinks.
export function ProjectTerminalIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="2.5" y="4" width="19" height="16" rx="2.5" />
			<path d="M2.5 8h19" />
			<circle cx="5.4" cy="6" r="0.55" fill="currentColor" stroke="none" className="hdr-ptd1" />
			<circle cx="7.6" cy="6" r="0.55" fill="currentColor" stroke="none" className="hdr-ptd2" />
			<path d="m6.5 11.5 2.5 2.25L6.5 16" pathLength={1} className="hdr-draw hdr-pt-prompt" />
			<path d="M12 16h4.5" className="hdr-pt-cursor" />
		</svg>
	);
}

// 09 — Pull: the arrow drops out of the cloud, the cloud bobs.
export function PullIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" className="hdr hdr-cloud-bob" />
			<g className="hdr hdr-pull-arrow">
				<path d="M12 12v9" />
				<path d="m8 17 4 4 4-4" />
			</g>
		</svg>
	);
}

// 11 — Pull success: the check draws itself, left to right.
export function PullSuccessIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className, 2)}>
			<path d="m4.5 12.5 5 5L19.5 7" pathLength={1} className="hdr-draw hdr-check" />
		</svg>
	);
}

// 12 — Pull alert: the triangle quakes, the exclamation blinks.
export function PullAlertIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="hdr hdr-quake">
				<path d="M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
				<g className="hdr-bang">
					<path d="M12 9v4" />
					<path d="M12 17h.01" />
				</g>
			</g>
		</svg>
	);
}

// 13 — Remote / QR: the inner marks flicker like a scanner sweeping the code.
export function RemoteQRIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="3" width="5" height="5" rx="1" />
			<rect x="16" y="3" width="5" height="5" rx="1" />
			<rect x="3" y="16" width="5" height="5" rx="1" />
			<path d="M12 7v3a2 2 0 0 1-2 2H7" className="hdr-qr1" />
			<path d="M21 16h-3a2 2 0 0 0-2 2v3" className="hdr-qr2" />
			<g className="hdr-qr3"><path d="M3 12h.01" /><path d="M12 3h.01" /></g>
			<g className="hdr-qr4"><path d="M12 16v.01" /><path d="M16 12h1" /></g>
			<g className="hdr-qr5"><path d="M21 21v.01" /><path d="M21 12v.01" /><path d="M12 21v-1" /></g>
		</svg>
	);
}

// 14 — Productivity stats: the needle revs to the redline and falls back.
export function StatsIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M3.34 19a10 10 0 1 1 17.32 0" />
			<path d="m12 14 4-4" className="hdr hdr-needle" />
		</svg>
	);
}

// 15 — GitHub: the octocat takes a polite little bow. Brand mark — shape kept.
export function GitHubIcon({ className }: HeaderIconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path
				className="hdr hdr-gh"
				d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
			/>
		</svg>
	);
}

// 16 — Report a bug: the bug wiggles and its antennae twitch.
export function ReportBugIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="hdr hdr-bug-body">
				<path d="m8 2 1.88 1.88" className="hdr hdr-ant-l" />
				<path d="M14.12 3.88 16 2" className="hdr hdr-ant-r" />
				<path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
				<path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
				<path d="M12 20v-9" />
				<path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
				<path d="M6 13H2" />
				<path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
				<path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
				<path d="M22 13h-4" />
				<path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
			</g>
		</svg>
	);
}

// 17 — Changelog: new entries write themselves onto the clipboard list.
export function ChangelogIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="8" y="2" width="8" height="4" rx="1" />
			<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
			<path d="M12 11h4" pathLength={1} className="hdr-draw hdr-cl-line1" />
			<path d="M12 16h4" pathLength={1} className="hdr-draw hdr-cl-line2" />
			<path d="M8 11h.01" className="hdr-cl-dot1" />
			<path d="M8 16h.01" className="hdr-cl-dot2" />
		</svg>
	);
}

// 18 — Overflow kebab: the dots do the wave, top to bottom.
export function KebabIcon({ className }: HeaderIconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
			<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" className="hdr hdr-kb1" />
			<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" className="hdr hdr-kb2" />
			<circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" className="hdr hdr-kb3" />
		</svg>
	);
}

// 19 — Project settings: the wrench gives the bolt two ratchet turns.
export function WrenchIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path
				d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
				className="hdr hdr-wrench"
			/>
		</svg>
	);
}

// 20 — Global settings: the knobs slide to a new mix and settle back.
export function SlidersIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M6 4v16" />
			<path d="M12 4v16" />
			<path d="M18 4v16" />
			<circle cx="6" cy="15.5" r="2" fill="currentColor" stroke="none" className="hdr hdr-sl1" />
			<circle cx="12" cy="8" r="2" fill="currentColor" stroke="none" className="hdr hdr-sl2" />
			<circle cx="18" cy="13" r="2" fill="currentColor" stroke="none" className="hdr hdr-sl3" />
		</svg>
	);
}

// 21 — Update ready: the arrow launches up into the cloud.
export function UpdateReadyIcon({ className }: HeaderIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" className="hdr hdr-cloud-bob" />
			<g className="hdr hdr-up-arrow">
				<path d="M12 21v-8" />
				<path d="m8 17 4-4 4 4" />
			</g>
		</svg>
	);
}
