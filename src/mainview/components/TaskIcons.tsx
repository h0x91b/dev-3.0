import type { SVGProps } from "react";

/**
 * Hand-drawn glyphs for the task header row (TaskInfoPanel and its sub-panels:
 * the watch toggle, bug-hunter and spawn-agent buttons, worktree settings,
 * TaskOpenIn, TaskScripts, TaskExposedPorts, TaskSharedImages, TaskArtifacts, and the
 * fullscreen / collapse panel chrome). They replace the old Nerd Font glyphs
 * and ad-hoc inline SVGs with a single stroke style consistent with the header
 * (HeaderIcons), tmux (TmuxIcons) and git (GitIcons) sets.
 *
 * Every icon carries `th-*` animation hooks: when a `.task-anim` ancestor (the
 * hosting button) is hovered, pure-CSS keyframes in index.css act out the
 * operation the icon triggers — the watch bell rings with sound waves, the
 * bug squirms under a focusing lens, the agent robot tilts hello and pings, the
 * open-in arrow launches out of its box, the file / port trees wire themselves
 * up, the scripts ƒ writes itself, the images sun rises at golden hour, the
 * settings gear ratchets, the fullscreen arrows burst out (or dive back in),
 * the panel chevron dips with a ghost echo. Idle rendering is pixel-identical
 * to the static icon.
 */

interface TaskIconProps {
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

// 01 — Watching (active): the bell rings, sound waves radiate off it.
export function WatchingIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-bell">
				<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4.6 1.9 6 1.9 6H4.6s1.9-1.4 1.9-6" />
				<path d="M10.4 19.3a1.8 1.8 0 0 0 3.2 0" />
			</g>
			<path d="M2.6 6.4c.5-1.5 1.5-2.7 2.8-3.5" className="th-wave-l" />
			<path d="M21.4 6.4c-.5-1.5-1.5-2.7-2.8-3.5" className="th-wave-r" />
		</svg>
	);
}

// 02 — Watch (idle): a plain bell that gives a hopeful little nudge.
export function WatchIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-bell-nudge">
				<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4.6 1.9 6 1.9 6H4.6s1.9-1.4 1.9-6" />
				<path d="M10.4 19.3a1.8 1.8 0 0 0 3.2 0" />
			</g>
		</svg>
	);
}

// Completion owner: a person claims the final decision; the check appears on
// hover and remains visible while completion prompts are disabled.
export function CompletionOwnerIcon({ className, active = false }: TaskIconProps & { active?: boolean }) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-owner-person">
				<circle cx="9" cy="7" r="2.8" />
				<path d="M3.8 19c.5-4 2.2-6 5.2-6 2.2 0 3.8 1.1 4.7 3.2" />
			</g>
			<g className="th-owner-badge">
				<circle cx="17.2" cy="16.8" r="4" />
				<path
					d="m15.3 16.8 1.25 1.25 2.45-2.7"
					pathLength={1}
					className={`th-owner-check${active ? "" : " th-owner-check-idle"}`}
				/>
			</g>
		</svg>
	);
}

// 03 — Find bugs: the lens focuses in, the caught bug squirms under it.
export function FindBugsIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-fb-lens">
				<circle cx="10.5" cy="10.5" r="7" />
			</g>
			<path d="m20.7 20.7-5.25-5.25" />
			<g className="th-fb-bug">
				<ellipse cx="10.5" cy="11.4" rx="2.1" ry="2.7" />
				<path d="m8.9 7.7.9 1.2" />
				<path d="m12.1 7.7-.9 1.2" />
				<path d="M10.5 8.7v5.4" />
				<path d="M8.4 10.6H6.4" />
				<path d="M12.6 10.6h2" />
				<path d="m6.7 13.7 1.7-.9" />
				<path d="m14.3 13.7-1.7-.9" />
			</g>
		</svg>
	);
}

// 04 — Add agent: the robot head tilts hello, eyes blink, antenna pings.
export function AddAgentIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-ro-head">
				<rect x="4.5" y="8.5" width="15" height="10" rx="2.5" />
				<circle cx="9.2" cy="13" r="1" fill="currentColor" stroke="none" className="th-ro-eye" />
				<circle cx="14.8" cy="13" r="1" fill="currentColor" stroke="none" className="th-ro-eye" />
				<path d="M9.7 16c.7.6 3.9.6 4.6 0" />
				<path d="M12 8.5V5.6" />
				<circle cx="12" cy="4.3" r="1.1" className="th-ro-ping" />
			</g>
			<path d="M4.5 12.5h-2" />
			<path d="M19.5 12.5h2" />
		</svg>
	);
}

// 05 — Open in…: the arrow launches out of the box; the box recoils.
export function OpenInIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M18.5 13v5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" className="th-oi-box" />
			<g className="th-oi-arrow">
				<path d="M15 3.5h5.5V9" />
				<path d="M20.5 3.5 12 12" />
			</g>
		</svg>
	);
}

// 06 — File browser: connectors wire up, the child folders pop into place.
export function FileTreeIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="2.5" width="7.5" height="5" rx="1.2" />
			<path d="M6.75 11.5h6.75" pathLength={1} className="th-draw th-ft-branch" />
			<path d="M6.75 7.5v10a1.5 1.5 0 0 0 1.5 1.5h5.25" pathLength={1} className="th-draw th-ft-trunk" />
			<rect x="13.5" y="9" width="7.5" height="5" rx="1.2" className="th-ft-c1" />
			<rect x="13.5" y="16.5" width="7.5" height="5" rx="1.2" className="th-ft-c2" />
		</svg>
	);
}

// 07 — Scripts: the ƒ writes itself in one stroke, crossbar last.
export function ScriptsIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<path d="M15.8 4.3c-2.3-.7-3.6.9-4 3.1l-1.9 10.2c-.4 2.2-1.7 3.2-3.7 2.6" pathLength={1} className="th-draw th-fn-stroke" />
			<path d="M7.8 10.5h7.2" pathLength={1} className="th-draw th-fn-bar" />
		</svg>
	);
}

// 08 — Ports: the wiring connects, then both endpoints come online.
export function PortsIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="8.75" y="2.5" width="6.5" height="5.5" rx="1.2" />
			<path d="M12 8v3.5" pathLength={1} className="th-draw th-po-link1" />
			<path d="M5.75 16v-2.5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2V16" pathLength={1} className="th-draw th-po-link2" />
			<rect x="2.5" y="16" width="6.5" height="5.5" rx="1.2" className="th-po-c1" />
			<rect x="15" y="16" width="6.5" height="5.5" rx="1.2" className="th-po-c2" />
		</svg>
	);
}

// 09 — Images: golden hour — the sun lifts, the ridges catch the light.
export function ImagesIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<circle cx="9" cy="9.8" r="1.7" className="th-im-sun" />
			<path d="m3 16.8 4.2-4.2a1.8 1.8 0 0 1 2.6 0l6.7 6.7" pathLength={1} className="th-draw th-im-m1" />
			<path d="m13.5 14.5 1.8-1.8a1.8 1.8 0 0 1 2.6 0l3.1 3.1" pathLength={1} className="th-draw th-im-m2" />
		</svg>
	);
}

// HTML artifact: a browser canvas with code brackets inside.
export function ArtifactsIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="3.5" width="18" height="17" rx="2.5" />
			<path d="M3 8h18" />
			<circle cx="6.2" cy="5.8" r=".6" fill="currentColor" stroke="none" />
			<path d="m9.5 12-2.5 2 2.5 2" />
			<path d="m14.5 12 2.5 2-2.5 2" />
			<path d="m13 10.8-2 6.4" />
		</svg>
	);
}

// 10 — Worktree settings: one ratchet turn forward, then it winds back.
export function WorktreeSettingsIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-gear">
				<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
				<circle cx="12" cy="12" r="3" />
			</g>
		</svg>
	);
}

// 11 — Full screen (enter): two arrows stretch out along the NE/SW diagonal,
// the macOS green-button gesture.
export function FullscreenEnterIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-fs-ne"><path d="m13.6 10.4 5.9-5.9" /><path d="M14.5 4.5h5v5" /></g>
			<g className="th-fs-sw"><path d="m10.4 13.6-5.9 5.9" /><path d="M9.5 19.5h-5v-5" /></g>
		</svg>
	);
}

// 12 — Full screen (exit): mirror move — the arrows dive back into the center.
export function FullscreenExitIcon({ className }: TaskIconProps) {
	return (
		<svg {...svgBase(className)}>
			<g className="th-fs-sw"><path d="m19.5 4.5-5.9 5.9" /><path d="M13.6 5.4v5h5" /></g>
			<g className="th-fs-ne"><path d="m4.5 19.5 5.9-5.9" /><path d="M10.4 18.6v-5h-5" /></g>
		</svg>
	);
}

// 13 — Sidebar panel toggle (VS Code-style layout glyph): a frame with a
// divider; the left pane is filled while the sidebar shows. On hover the pane
// fades toward its post-click state — out for "hide", in for "show".
export function PanelLeftIcon({ className, open }: TaskIconProps & { open?: boolean }) {
	return (
		<svg {...svgBase(className)}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="M9.5 4.5v15" />
			<rect
				x="5.1"
				y="6.6"
				width="2.4"
				height="10.8"
				rx="0.7"
				fill="currentColor"
				stroke="none"
				opacity={open ? 1 : 0}
				className={open ? "th-panel-hide" : "th-panel-show"}
			/>
		</svg>
	);
}

// 14 — Panel chevron: it dips in its pointing direction, a ghost drips after.
export function PanelChevronIcon({ className, direction = "down" }: TaskIconProps & { direction?: "up" | "down" }) {
	const d = direction === "up" ? "m6.5 14.5 5.5-5.5 5.5 5.5" : "m6.5 9.5 5.5 5.5 5.5-5.5";
	const move = direction === "up" ? "th-col-up" : "th-col";
	const ghost = direction === "up" ? "th-col-up-ghost" : "th-col-ghost";
	return (
		<svg {...svgBase(className, 2)}>
			<path d={d} className={move} />
			<path d={d} className={ghost} opacity="0" />
		</svg>
	);
}
