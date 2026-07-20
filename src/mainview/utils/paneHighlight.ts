import type { TmuxLayout } from "../../shared/types";

/** A rectangle expressed in % of the terminal canvas, for an absolute overlay. */
export interface PaneRectPct {
	leftPct: number;
	topPct: number;
	widthPct: number;
	heightPct: number;
}

/**
 * The %-rect of ONE tmux pane over the full terminal canvas (pane area + the
 * status-bar rows), for the ⌘F search highlight overlay.
 *
 * Same cells→% mapping as `ClosePanePicker` (kept in lockstep with it): the
 * canvas renders the whole terminal including the tmux status bar, which the
 * per-pane geometry excludes, so vertical positions map over `winH + statusLines`
 * and shift down by the status bar when it sits on top. A zoomed window shows
 * only its active pane, so the box covers the whole pane area.
 *
 * Returns null — i.e. draw nothing — when:
 * - the layout is empty / the pane is gone,
 * - the pinned pane is in a window that isn't the one on screen (highlighting it
 *   over a different window would be misleading), or
 * - that window has a single pane (no ambiguity about where search runs).
 */
export function paneHighlightRect(layout: TmuxLayout | null, paneId: string): PaneRectPct | null {
	if (!layout?.exists) return null;
	const pane = layout.panes.find((p) => p.paneId === paneId);
	if (!pane) return null;

	const activeWindow = layout.windows.find((w) => w.active) ?? layout.windows[0];
	if (!activeWindow || activeWindow.index !== pane.windowIndex) return null;

	const winPanes = layout.panes.filter((p) => p.windowIndex === pane.windowIndex);
	// Single pane → the whole terminal IS the search target; a frame would be noise.
	if (winPanes.length < 2) return null;

	const statusLines = Math.max(0, layout.statusLines ?? 0);
	const statusTop = layout.statusAtTop ? statusLines : 0;
	const winW = Math.max(1, ...winPanes.map((p) => p.left + p.width));
	const winH = Math.max(1, ...winPanes.map((p) => p.top + p.height));
	const canvasH = winH + statusLines;

	// Zoomed: only the active pane is visible, covering the entire pane area.
	if (activeWindow.zoomed) {
		return { leftPct: 0, topPct: (statusTop / canvasH) * 100, widthPct: 100, heightPct: (winH / canvasH) * 100 };
	}

	return {
		leftPct: (pane.left / winW) * 100,
		topPct: ((statusTop + pane.top) / canvasH) * 100,
		widthPct: (pane.width / winW) * 100,
		heightPct: (pane.height / canvasH) * 100,
	};
}
