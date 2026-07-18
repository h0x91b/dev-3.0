import { describe, it, expect } from "vitest";
import {
	tmuxFormat,
	parseWindowLayout,
	TMUX_FORMAT_SEPARATOR,
	PANE_ID_FORMAT,
	ALL_PANE_PIDS_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	PANE_GEOMETRY_FORMAT,
	PANE_SWITCHER_FORMAT,
	ALT_CLICK_PANE_FORMAT,
	STATUS_GEOMETRY_FORMAT,
} from "../formats";

describe("tmuxFormat builder", () => {
	it("builds a TAB-separated -F string in declaration order", () => {
		const format = tmuxFormat().string("a", "var_a").number("b", "var_b").flag("c", "var_c").build();
		expect(format.formatString).toBe("#{var_a}\t#{var_b}\t#{var_c}");
		expect(TMUX_FORMAT_SEPARATOR).toBe("\t");
	});

	it("parses typed rows: string, number (NaN→0), flag ('1'→true)", () => {
		const format = tmuxFormat().string("id", "x").number("n", "y").flag("on", "z").build();
		expect(format.parse("%5\t42\t1\n%6\tnope\t0\n")).toEqual([
			{ id: "%5", n: 42, on: true },
			{ id: "%6", n: 0, on: false },
		]);
	});

	it("drops empty lines and lines with fewer columns than declared", () => {
		const format = tmuxFormat().string("a", "x").string("b", "y").build();
		expect(format.parse("only-one-column\n\nfoo\tbar\n")).toEqual([{ a: "foo", b: "bar" }]);
	});

	it("tail field rejoins embedded separators so typed columns cannot shift", () => {
		const format = tmuxFormat().string("paneId", "pane_id").tail("title", "pane_title").build();
		expect(format.parse("%1\tmy\tweird\ttitle\n")).toEqual([
			{ paneId: "%1", title: "my\tweird\ttitle" },
		]);
	});

	it("tail field may be empty", () => {
		const format = tmuxFormat().string("a", "x").tail("rest", "y").build();
		expect(format.parse("v\t\n")).toEqual([{ a: "v", rest: "" }]);
	});

	it("refuses to declare a field after the tail", () => {
		expect(() => tmuxFormat().tail("t", "x").string("a", "y")).toThrow(/after a tail field/);
	});
});

describe("format declarations", () => {
	it("PANE_ID_FORMAT is the bare pane id", () => {
		expect(PANE_ID_FORMAT.formatString).toBe("#{pane_id}");
		expect(PANE_ID_FORMAT.parse("%0\n%12\n")).toEqual([{ paneId: "%0" }, { paneId: "%12" }]);
	});

	it("ALL_PANE_PIDS_FORMAT puts the free-text session name last", () => {
		expect(ALL_PANE_PIDS_FORMAT.formatString).toBe("#{pane_pid}\t#{session_name}");
		expect(ALL_PANE_PIDS_FORMAT.parse("42\tmy session\twith tab\n")).toEqual([
			{ panePid: 42, sessionName: "my session\twith tab" },
		]);
	});

	it("SESSION_OVERVIEW_FORMAT parses windows/created as numbers and cwd as tail", () => {
		const rows = SESSION_OVERVIEW_FORMAT.parse("dev3-abc12345\t2\t1752800000\t/tmp/some dir\n");
		expect(rows).toEqual([
			{ name: "dev3-abc12345", windowCount: 2, createdAt: 1752800000, cwd: "/tmp/some dir" },
		]);
	});

	it("PANE_GEOMETRY_FORMAT keeps pane_title as the tail field", () => {
		const rows = PANE_GEOMETRY_FORMAT.parse("0\t%1\t1\t0\t0\t99\t50\tclaude\tAgent pane\n");
		expect(rows[0]).toMatchObject({
			windowIndex: 0, paneId: "%1", active: true,
			left: 0, top: 0, width: 99, height: 50,
			command: "claude", title: "Agent pane",
		});
	});

	it("PANE_SWITCHER_FORMAT carries host_short to detect unset titles", () => {
		const rows = PANE_SWITCHER_FORMAT.parse("%1\t1\t0\tzsh\tmyhost\tmyhost\n");
		expect(rows[0]).toMatchObject({ paneId: "%1", active: true, zoomed: false, command: "zsh", hostShort: "myhost", title: "myhost" });
	});

	it("STATUS_GEOMETRY_FORMAT keeps status as a raw string (off/on/N)", () => {
		const row = STATUS_GEOMETRY_FORMAT.parse("51\t50\ton\tbottom\n")[0];
		expect(row).toEqual({ clientHeight: 51, windowHeight: 50, status: "on", statusPosition: "bottom" });
	});

	it("ALT_CLICK_PANE_FORMAT asks for pane_current_command last (separator-safety)", () => {
		expect(ALT_CLICK_PANE_FORMAT.formatString.endsWith("#{pane_current_command}")).toBe(true);
		expect(ALT_CLICK_PANE_FORMAT.formatString.startsWith("#{pane_id}")).toBe(true);
	});
});

describe("parseWindowLayout", () => {
	it("extracts leaf geometry keyed by pane id, ignoring containers", () => {
		const geom = parseWindowLayout("21be,200x50,0,0{100x50,0,0,0,99x50,101,0[99x25,101,0,1,99x24,101,26,2]}");
		expect(geom.get("%0")).toEqual({ left: 0, top: 0, width: 100, height: 50 });
		expect(geom.get("%1")).toEqual({ left: 101, top: 0, width: 99, height: 25 });
		expect(geom.get("%2")).toEqual({ left: 101, top: 26, width: 99, height: 24 });
		// The container cell (99x50,101,0) must not be mistaken for a pane.
		expect(geom.size).toBe(3);
	});

	it("maps the trailing integer to pane id (not pane index) after a kill", () => {
		// Non-contiguous ids: %0 and %2 survive; layout uses ids 0 and 2.
		const geom = parseWindowLayout("4f3b,200x50,0,0{100x50,0,0,0,99x50,101,0,2}");
		expect(geom.has("%0")).toBe(true);
		expect(geom.has("%2")).toBe(true);
		expect(geom.has("%1")).toBe(false);
	});

	it("returns an empty map for an empty/garbage layout", () => {
		expect(parseWindowLayout("").size).toBe(0);
		expect(parseWindowLayout("not-a-layout").size).toBe(0);
	});
});
