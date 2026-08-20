/**
 * The backend-neutral pane vocabulary for a task's PRIMARY terminal (seq 1311).
 *
 * The product asks for pane COUNT, SPLIT, FOCUS, RESIZE, ZOOM, CLOSE and named
 * LAYOUTS; whether those land on tmux panes or on native SplitTree panes is the
 * backend's business, never the renderer's. No raw tmux verb, pane id format,
 * layout name, or socket appears here.
 *
 * Geometry naming follows the product's existing controls, NOT tmux's:
 *  • `splitH` splits along a HORIZONTAL divider → the new pane sits BELOW
 *    (tmux `split-window -v`, SplitTree orientation `vertical`);
 *  • `splitV` splits along a VERTICAL divider → the new pane sits to the RIGHT
 *    (tmux `split-window -h`, SplitTree orientation `horizontal`).
 * The layout presets follow the same convention, so `evenH` stacks panes.
 */

import type { SplitDirection } from "./split-tree";

export type TaskPaneBackendKind = "tmux" | "native";

/** Which named layout the product offers, in the order its menu lists them. */
export type TaskPaneLayoutPreset = "tiled" | "evenH" | "evenV" | "mainH" | "mainV";

export const TASK_PANE_LAYOUT_PRESETS: readonly TaskPaneLayoutPreset[] = [
	"tiled",
	"evenH",
	"evenV",
	"mainH",
	"mainV",
];

/** Normalized position inside the terminal area, both backends report the same box. */
export interface TaskPaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TaskPaneInfo {
	/** Backend-stable pane identity: a tmux `%N` or a native `pane-N`. */
	paneId: string;
	/** Position in layout order, so a pager can label panes without a second query. */
	index: number;
	label: string;
	active: boolean;
	zoomed: boolean;
	rect: TaskPaneRect;
	/**
	 * Native only: the PTY session key this pane's own viewer connects to. A tmux
	 * task streams every pane through one session, so it has none.
	 */
	sessionKey?: string;
	hostPid?: number;
	shellPid?: number;
	alive?: boolean;
}

/**
 * What the backend can actually do. A control whose capability is missing must be
 * visibly disabled with a reason — never rendered as if it worked.
 */
export type TaskPaneCapability =
	| "split"
	| "focus"
	| "focusDirection"
	| "zoom"
	| "close"
	| "closePick"
	| "resize"
	/** Boundaries are addressable and can be set to an absolute ratio (native only). */
	| "resizeSplit"
	| "layoutPreset"
	| "layoutCycle"
	| "newWindow";

export interface TaskPaneState {
	backend: TaskPaneBackendKind;
	panes: TaskPaneInfo[];
	activePaneId: string | null;
	zoomedPaneId: string | null;
	/** Native only: the serialized shared SplitTree that produced `panes`. */
	layout: string | null;
	/** Native only: the preset the shared layout currently matches, if any. */
	layoutPreset: TaskPaneLayoutPreset | null;
	capabilities: TaskPaneCapability[];
	/**
	 * Native only: the backend looked for this task's session and found none — the
	 * host is gone, or was never started. Without it an empty `panes` array means
	 * both "nothing is there" and "not loaded yet", and a reader picking the
	 * optimistic one spins on "Connecting…" forever. tmux reports session loss by
	 * throwing, so it never sets this.
	 */
	sessionAbsent?: boolean;
}

export type TaskPaneAction =
	| { kind: "splitH" | "splitV"; paneId?: string }
	| { kind: "focus"; paneId: string }
	| { kind: "focusStep"; step: "next" | "prev" }
	| { kind: "focusDirection"; direction: SplitDirection }
	| { kind: "zoom"; paneId?: string; mode?: "toggle" | "on" | "off" }
	| { kind: "close"; paneId?: string; force?: boolean }
	| { kind: "resize"; direction: SplitDirection; amount?: number; paneId?: string }
	/**
	 * Set one boundary to an absolute ratio — what a divider drag produces. Direction
	 * plus an amount cannot express it: a drag knows the split it grabbed and where it
	 * let go, not how many steps that was. Backends without addressable boundaries
	 * (tmux) do not advertise `resizeSplit` and ignore it.
	 */
	| { kind: "setSplitRatio"; splitId: string; ratio: number }
	| { kind: "layoutPreset"; preset: TaskPaneLayoutPreset }
	| { kind: "layoutCycle" };

export function taskPaneSupports(state: TaskPaneState, capability: TaskPaneCapability): boolean {
	return state.capabilities.includes(capability);
}

/** The preset after `current`, or the first one when the layout matches none. */
export function nextTaskPaneLayoutPreset(current: TaskPaneLayoutPreset | null): TaskPaneLayoutPreset {
	if (current === null) return TASK_PANE_LAYOUT_PRESETS[0];
	const index = TASK_PANE_LAYOUT_PRESETS.indexOf(current);
	return TASK_PANE_LAYOUT_PRESETS[(index + 1) % TASK_PANE_LAYOUT_PRESETS.length];
}
