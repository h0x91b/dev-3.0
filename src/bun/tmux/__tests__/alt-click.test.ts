import { describe, expect, it } from "vitest";
import {
	type AltClickPane,
	altClickIneligibleReason,
	computeAltClickKeys,
	findAltClickPane,
	isShellCommand,
	parseAltClickPanes,
} from "../alt-click";
import { ALT_CLICK_PANE_FORMAT } from "../formats";

function pane(over: Partial<AltClickPane> = {}): AltClickPane {
	return {
		paneId: "%1",
		active: true,
		left: 0,
		top: 1, // dev3 status bar sits on row 0
		width: 120,
		height: 40,
		inMode: false,
		dead: false,
		cursorX: 10,
		cursorY: 5,
		command: "zsh",
		zoomed: false,
		...over,
	};
}

describe("parseAltClickPanes", () => {
	it("parses the tab-separated format produced by ALT_CLICK_PANE_FORMAT", () => {
		// Mirrors real output: two side-by-side shell panes under a top status bar.
		const out = [
			"%1306\t0\t0\t1\t128\t80\t0\t0\t2\t76\t0\tzsh",
			"%1522\t1\t129\t1\t129\t80\t0\t0\t49\t27\t0\tnode",
			"",
		].join("\n");
		const panes = parseAltClickPanes(out);
		expect(panes).toHaveLength(2);
		expect(panes[0]).toMatchObject({
			paneId: "%1306", active: false, left: 0, top: 1, width: 128, height: 80,
			inMode: false, dead: false, cursorX: 2, cursorY: 76, zoomed: false, command: "zsh",
		});
		expect(panes[1]).toMatchObject({ paneId: "%1522", active: true, left: 129, command: "node" });
	});

	it("drops malformed lines and keeps the command intact", () => {
		expect(parseAltClickPanes("garbage\n%1\t1\t0\t0\t10\t10\t0\t0\t0\t0\t0\tzsh")).toHaveLength(1);
		expect(parseAltClickPanes("")).toHaveLength(0);
	});

	it("format asks for pane_current_command last (tab-safety)", () => {
		expect(ALT_CLICK_PANE_FORMAT.formatString.endsWith("#{pane_current_command}")).toBe(true);
	});
});

describe("isShellCommand", () => {
	it("accepts common shells, including login-shell dash prefix", () => {
		for (const cmd of ["zsh", "bash", "fish", "sh", "-zsh", "Bash"]) {
			expect(isShellCommand(cmd), cmd).toBe(true);
		}
	});

	it("rejects TUIs, pagers, remotes and REPLs", () => {
		for (const cmd of ["node", "claude", "vim", "htop", "less", "man", "ssh", "python3", ""]) {
			expect(isShellCommand(cmd), cmd).toBe(false);
		}
	});
});

describe("findAltClickPane", () => {
	const left = pane({ paneId: "%L", left: 0, top: 1, width: 128, height: 80 });
	const right = pane({ paneId: "%R", left: 129, top: 1, width: 129, height: 80, active: false });

	it("hit-tests the pane containing the cell", () => {
		expect(findAltClickPane([left, right], 5, 10)?.paneId).toBe("%L");
		expect(findAltClickPane([left, right], 200, 10)?.paneId).toBe("%R");
	});

	it("returns null for the border column and the status-bar row", () => {
		expect(findAltClickPane([left, right], 128, 10)).toBeNull(); // border between panes
		expect(findAltClickPane([left, right], 5, 0)).toBeNull(); // status bar (top=1)
	});

	it("only considers the active pane when the window is zoomed", () => {
		// Zoomed: active pane covers the window; the hidden pane keeps stale
		// geometry that must not win the hit-test.
		const zoomedActive = pane({ paneId: "%Z", left: 0, top: 1, width: 258, height: 80, zoomed: true });
		const hidden = pane({ paneId: "%H", left: 129, top: 1, width: 129, height: 80, active: false, zoomed: true });
		expect(findAltClickPane([hidden, zoomedActive], 200, 10)?.paneId).toBe("%Z");
	});

	it("skips dead panes", () => {
		expect(findAltClickPane([pane({ dead: true })], 5, 10)).toBeNull();
	});
});

describe("altClickIneligibleReason", () => {
	it("accepts a live shell pane", () => {
		expect(altClickIneligibleReason(pane())).toBeNull();
	});

	it("rejects copy-mode, dead panes, and non-shells (claude/vim/htop)", () => {
		expect(altClickIneligibleReason(pane({ inMode: true }))).toMatch(/copy-mode/);
		expect(altClickIneligibleReason(pane({ dead: true }))).toMatch(/dead/);
		expect(altClickIneligibleReason(pane({ command: "node" }))).toMatch(/not a shell/);
	});
});

describe("computeAltClickKeys", () => {
	// pane top=1, cursor pane-relative (10, 5) → window row of the cursor is 6.
	const rowText = "/repo % echo hello world"; // length 24

	it("moves Right by the exact column delta on the cursor row", () => {
		// click window col 15 → pane-relative 15; cursor at 10 → 5 Rights
		expect(computeAltClickKeys(pane(), 15, 6, rowText)).toEqual({ key: "Right", count: 5 });
	});

	it("moves Left by the exact column delta", () => {
		expect(computeAltClickKeys(pane(), 3, 6, rowText)).toEqual({ key: "Left", count: 7 });
	});

	it("returns null for a cross-row click (vertical = history, not motion)", () => {
		expect(computeAltClickKeys(pane(), 15, 7, rowText)).toBeNull();
		expect(computeAltClickKeys(pane(), 15, 1, rowText)).toBeNull();
	});

	it("returns null when the click lands on the cursor cell", () => {
		expect(computeAltClickKeys(pane(), 10, 6, rowText)).toBeNull();
	});

	it("clamps a click in the blank area to end-of-line (no autosuggest overshoot)", () => {
		// click far right of the 24-char text → target clamps to col 24 (EOL), not 100
		expect(computeAltClickKeys(pane(), 100, 6, rowText)).toEqual({ key: "Right", count: 14 });
	});

	it("ignores trailing whitespace when measuring the line", () => {
		expect(computeAltClickKeys(pane(), 100, 6, "abcde   ")).toEqual({ key: "Left", count: 5 });
	});

	it("accounts for the pane's left offset in a horizontal split", () => {
		const right = pane({ left: 129, cursorX: 10 });
		// window col 149 → pane-relative 20 → 10 Rights from cursor 10
		expect(computeAltClickKeys(right, 149, 6, rowText)).toEqual({ key: "Right", count: 10 });
	});

	it("caps the key count at the pane width", () => {
		const tiny = pane({ width: 4, cursorX: 0 });
		expect(computeAltClickKeys(tiny, 3, 6, "0123456789")?.count).toBe(3);
		const capped = computeAltClickKeys(pane({ width: 4, cursorX: 200 }), 0, 6, "");
		expect(capped).toEqual({ key: "Left", count: 4 });
	});
});
