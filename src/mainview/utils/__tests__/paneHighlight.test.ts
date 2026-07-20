import { describe, it, expect } from "vitest";
import type { TmuxLayout } from "../../../shared/types";
import { paneHighlightRect } from "../paneHighlight";

// Two side-by-side panes in the active window (winW = 200, winH = 50, no status bar).
const TWO_PANES: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 99, height: 50, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 100, top: 0, width: 100, height: 50, command: "zsh", title: "Shell" },
	],
};

const ONE_PANE: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 1, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 200, height: 50, command: "claude", title: "Agent" },
	],
};

const ZOOMED: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: true }],
	panes: TWO_PANES.panes,
};

// Two vertically-stacked panes with a 1-cell divider (top 0..28, bottom 30..57)
// over a 58-row pane area, plus a 1-row BOTTOM status bar → 59-row canvas.
const VSTACK: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	statusLines: 1,
	statusAtTop: false,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true, left: 0, top: 0, width: 100, height: 29, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 0, top: 30, width: 100, height: 28, command: "zsh", title: "Shell" },
	],
};

// Same as VSTACK but the status bar sits on TOP (pane area starts 1 row down).
const VSTACK_STATUS_TOP: TmuxLayout = { ...VSTACK, statusAtTop: true };

// A second window (index 1) is active on screen; the pinned pane %1 lives in the
// background window 0.
const TWO_WINDOWS: TmuxLayout = {
	sessionName: "dev3-task1",
	exists: true,
	windows: [
		{ index: 0, name: "main", active: false, panes: 2, zoomed: false },
		{ index: 1, name: "logs", active: true, panes: 1, zoomed: false },
	],
	panes: [
		...TWO_PANES.panes,
		{ windowIndex: 1, paneId: "%9", active: true, left: 0, top: 0, width: 200, height: 50, command: "tail", title: "Logs" },
	],
};

describe("paneHighlightRect", () => {
	it("returns null for a single-pane window (no ambiguity to signal)", () => {
		expect(paneHighlightRect(ONE_PANE, "%1")).toBeNull();
	});

	it("maps the left pane of a horizontal split", () => {
		expect(paneHighlightRect(TWO_PANES, "%1")).toEqual({
			leftPct: 0,
			topPct: 0,
			widthPct: (99 / 200) * 100,
			heightPct: 100,
		});
	});

	it("maps the right pane of a horizontal split", () => {
		expect(paneHighlightRect(TWO_PANES, "%2")).toEqual({
			leftPct: (100 / 200) * 100,
			topPct: 0,
			widthPct: (100 / 200) * 100,
			heightPct: 100,
		});
	});

	it("reserves the bottom status-bar row when mapping vertical positions", () => {
		// canvasH = 58 pane rows + 1 status row = 59.
		expect(paneHighlightRect(VSTACK, "%2")).toEqual({
			leftPct: 0,
			topPct: (30 / 59) * 100,
			widthPct: 100,
			heightPct: (28 / 59) * 100,
		});
	});

	it("shifts panes down by a top status bar", () => {
		// statusTop = 1, so the top pane starts one row down over the 59-row canvas.
		expect(paneHighlightRect(VSTACK_STATUS_TOP, "%1")).toEqual({
			leftPct: 0,
			topPct: (1 / 59) * 100,
			widthPct: 100,
			heightPct: (29 / 59) * 100,
		});
	});

	it("covers the whole pane area for a zoomed window", () => {
		expect(paneHighlightRect(ZOOMED, "%1")).toEqual({
			leftPct: 0,
			topPct: 0,
			widthPct: 100,
			heightPct: 100,
		});
	});

	it("returns null when the pinned pane is in a background window", () => {
		// %1 is in window 0, but window 1 is on screen — highlighting %1 would draw
		// over the wrong window.
		expect(paneHighlightRect(TWO_WINDOWS, "%1")).toBeNull();
	});

	it("highlights the sole pane of the on-screen window only if it has siblings", () => {
		// Window 1 (active) has a single pane → no highlight.
		expect(paneHighlightRect(TWO_WINDOWS, "%9")).toBeNull();
	});

	it("returns null for an unknown pane id", () => {
		expect(paneHighlightRect(TWO_PANES, "%404")).toBeNull();
	});

	it("returns null for a missing or non-existent layout", () => {
		expect(paneHighlightRect(null, "%1")).toBeNull();
		expect(paneHighlightRect({ sessionName: "s", exists: false, windows: [], panes: [] }, "%1")).toBeNull();
	});
});
