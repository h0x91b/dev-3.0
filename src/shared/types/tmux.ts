import type { PortInfo, ResourceUsage } from "./system-resources";

// ---- tmux layout (dev3 ui state) ----

export interface TmuxWindowInfo {
	index: number;
	name: string;
	active: boolean;
	panes: number;
	/**
	 * Whether this window is currently zoomed to a single pane. When true, only
	 * the active pane is visible on screen even though `panes` still reports the
	 * real split — the close-pane picker uses this to overlay a single hit-box
	 * instead of the (invisible) multi-pane geometry.
	 */
	zoomed: boolean;
}

export interface TmuxPaneInfo {
	windowIndex: number;
	paneId: string;
	active: boolean;
	/** Geometry in character cells, relative to the window. */
	left: number;
	top: number;
	width: number;
	height: number;
	command: string;
	title: string;
}

/**
 * One tmux window of a task session, as the in-app window navigator shows it.
 * Identity is `windowId` (`@N`, stable); `index` is tmux's display number and
 * renumbers when a window closes. `home` marks the window holding the agent.
 */
export interface TmuxWindowEntry {
	windowId: string;
	index: number;
	/** Display name; empty means "no meaningful name" — the UI shows "Window N". */
	label: string;
	/** The name the user gave this window from the tab bar; outranks `label` and the task title. */
	customName?: string;
	active: boolean;
	home: boolean;
	panes: number;
	/** Epoch seconds of the window's last output. */
	activity: number;
	bell: boolean;
}

export interface TmuxLayout {
	sessionName: string;
	exists: boolean;
	windows: TmuxWindowInfo[];
	panes: TmuxPaneInfo[];
	/**
	 * Rows the tmux status bar reserves from the terminal. Pane geometry above is
	 * the WINDOW (pane area) and excludes these rows, but the rendered canvas
	 * includes them — the close-pane picker adds this back so its overlay lines up
	 * vertically. Omitted/0 when the status bar is off or couldn't be measured.
	 */
	statusLines?: number;
	/** True when the status bar sits on top (so the pane area starts `statusLines` rows down). */
	statusAtTop?: boolean;
}

// ---- Tmux sessions ----

export interface TmuxSessionInfo {
	name: string;
	cwd: string;
	createdAt: number;
	windowCount: number;
	isCleanup: boolean;
	isProjectTerminal?: boolean;
	projectName?: string;
	taskTitle?: string;
	taskId?: string;
	projectId?: string;
	ports?: PortInfo[];
	resourceUsage?: ResourceUsage;
}

/**
 * One PTY session's read-vs-sent counters, as the Debug → Terminal Performance
 * overlay reads them. Rates are per second over the last closed window; the
 * gauges are instantaneous. `bytesIn` outrunning `bytesOut` means a backlog, and
 * the two gauges say whether it is here or further downstream.
 */
export interface PtyThroughputStats {
	bytesIn: number;
	bytesOut: number;
	messages: number;
	drops: number;
	droppedBytes: number;
	queued: number;
	socketBuffered: number;
	windowMs: number;
	queuedPeak: number;
	socketPeak: number;
}
