import { describe, it, expect } from "vitest";
import {
	tmuxFormat,
	parseWindowLayout,
	TMUX_FORMAT_SEPARATOR,
	SERVER_IDENTITY_FORMAT,
	ALL_PANE_PIDS_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	PANE_CAPTURE_FORMAT,
	PANE_GEOMETRY_FORMAT,
	PANE_SWITCHER_FORMAT,
	PEEK_PANE_FORMAT,
	ALT_CLICK_PANE_FORMAT,
	SEARCH_STATE_FORMAT,
	PANE_SPLIT_LAYOUT_FORMAT,
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
		// Empty lines and lines with fewer columns than declared are dropped.
		const pair = tmuxFormat().string("a", "x").string("b", "y").build();
		expect(pair.parse("only-one-column\n\nfoo\tbar\n")).toEqual([{ a: "foo", b: "bar" }]);
	});

	it("tail field rejoins embedded separators so typed columns cannot shift, and may be empty", () => {
		const format = tmuxFormat().string("paneId", "pane_id").tail("title", "pane_title").build();
		expect(format.parse("%1\tmy\tweird\ttitle\n")).toEqual([
			{ paneId: "%1", title: "my\tweird\ttitle" },
		]);
		const rest = tmuxFormat().string("a", "x").tail("rest", "y").build();
		expect(rest.parse("v\t\n")).toEqual([{ a: "v", rest: "" }]);
	});

	it("refuses to declare a field after the tail", () => {
		expect(() => tmuxFormat().tail("t", "x").string("a", "y")).toThrow(/after a tail field/);
	});
});

describe("format declarations", () => {
	it("PANE_SPLIT_LAYOUT_FORMAT carries window, cells, agent tag and a tab-safe launch command", () => {
		expect(PANE_SPLIT_LAYOUT_FORMAT.formatString).toBe(
			"#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{@dev3_agent}\t#{pane_start_command}",
		);
		expect(PANE_SPLIT_LAYOUT_FORMAT.parse("@1\t%3\t150\t40\t0\t\t'dev3' 'a\tb'\n")).toEqual([
			{ windowId: "@1", paneId: "%3", width: 150, height: 40, dead: false, agentTag: "", startCommand: "'dev3' 'a\tb'" },
		]);
	});

	it("free-text columns (session name, cwd, title) ride last as the tail; ids and numbers parse typed", () => {
		expect(SERVER_IDENTITY_FORMAT.formatString).toBe("#{socket_path}\t#{pid}");
		expect(SERVER_IDENTITY_FORMAT.parse("/private/tmp/tmux-501/dev3\t4242\n")).toEqual([{ socketPath: "/private/tmp/tmux-501/dev3", serverPid: 4242 }]);
		expect(ALL_PANE_PIDS_FORMAT.formatString).toBe("#{pane_pid}\t#{session_name}");
		expect(ALL_PANE_PIDS_FORMAT.parse("42\tmy session\twith tab\n")).toEqual([
			{ panePid: 42, sessionName: "my session\twith tab" },
		]);
		expect(SESSION_OVERVIEW_FORMAT.parse("dev3-abc12345\t2\t1752800000\t/tmp/some dir\n")).toEqual([
			{ name: "dev3-abc12345", windowCount: 2, createdAt: 1752800000, cwd: "/tmp/some dir" },
		]);
		expect(PANE_GEOMETRY_FORMAT.parse("0\t%1\t1\t0\t0\t99\t50\tclaude\tAgent pane\n")[0]).toMatchObject({
			windowIndex: 0, paneId: "%1", active: true,
			left: 0, top: 0, width: 99, height: 50,
			command: "claude", title: "Agent pane",
		});
		// host_short rides along to detect unset titles.
		expect(PANE_SWITCHER_FORMAT.parse("%1\t1\t0\tzsh\tmyhost\tmyhost\n")[0]).toMatchObject({ paneId: "%1", active: true, zoomed: false, command: "zsh", hostShort: "myhost", title: "myhost" });
	});

	it("PANE_CAPTURE_FORMAT reports geometry, liveness, and history depth with no free text", () => {
		const rows = PANE_CAPTURE_FORMAT.parse("%1\t120\t40\t0\t7788\t1785758259\t1500\t0\n");
		expect(rows).toEqual([
			{
				paneId: "%1",
				width: 120,
				height: 40,
				dead: false,
				pid: 7788,
				serverEpoch: 1785758259,
				historySize: 1500,
				alternateScreen: false,
			},
		]);
		// A capture must never carry a title, a command, or any other process fact.
		expect(PANE_CAPTURE_FORMAT.formatString).not.toContain("pane_title");
		expect(PANE_CAPTURE_FORMAT.formatString).not.toContain("pane_current_command");
		expect(PANE_CAPTURE_FORMAT.fields.some((field) => field.kind === "tail")).toBe(false);
		// A dead pane inside an alternate screen.
		expect(PANE_CAPTURE_FORMAT.parse("%9\t80\t24\t1\t0\t1785758259\t0\t1\n")[0]).toMatchObject({ dead: true, alternateScreen: true, historySize: 0 });
	});

	it("PANE_SWITCHER_FORMAT carries host_short to detect unset titles", () => {
		const rows = PANE_SWITCHER_FORMAT.parse("%1\t1\t0\tzsh\tmyhost\tmyhost\n");
		expect(rows[0]).toMatchObject({ paneId: "%1", active: true, zoomed: false, command: "zsh", hostShort: "myhost", title: "myhost" });
	});

	it("PEEK_PANE_FORMAT parses window activity and keeps the title as the tail", () => {
		const rows = PEEK_PANE_FORMAT.parse("%1\t1\t0\t1785801206\tzsh\tmyhost\tThinking\tabout\tauth\n");
		expect(rows[0]).toEqual({
			paneId: "%1",
			active: true,
			dead: false,
			windowActivity: 1785801206,
			command: "zsh",
			hostShort: "myhost",
			// A TAB inside the title cannot shift the typed columns before it.
			title: "Thinking\tabout\tauth",
		});
		// A WINDOW activity time — tmux has no per-pane one.
		expect(PEEK_PANE_FORMAT.formatString).toContain("#{window_activity}");
		expect(PEEK_PANE_FORMAT.formatString).not.toContain("pane_activity");
		expect(PEEK_PANE_FORMAT.formatString.endsWith("#{pane_title}")).toBe(true);
	});

	it("ALT_CLICK_PANE_FORMAT asks for pane_current_command last (separator-safety)", () => {
		expect(ALT_CLICK_PANE_FORMAT.formatString.endsWith("#{pane_current_command}")).toBe(true);
		expect(ALT_CLICK_PANE_FORMAT.formatString.startsWith("#{pane_id}")).toBe(true);
	});

	it("SEARCH_STATE_FORMAT parses present as flag and count as number", () => {
		expect(SEARCH_STATE_FORMAT.formatString).toBe("#{search_present}\t#{search_count}");
		// After a miss tmux reports present=0 with a STALE count — the format
		// still parses both; consumers gate the count on `present`.
		expect(SEARCH_STATE_FORMAT.parse("1\t6\n")).toEqual([{ present: true, count: 6 }]);
		expect(SEARCH_STATE_FORMAT.parse("0\t6\n")).toEqual([{ present: false, count: 6 }]);
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

		// The trailing integer is the pane id, not the index: after a kill %0 and %2 survive.
		const killed = parseWindowLayout("4f3b,200x50,0,0{100x50,0,0,0,99x50,101,0,2}");
		expect(killed.has("%0")).toBe(true);
		expect(killed.has("%2")).toBe(true);
		expect(killed.has("%1")).toBe(false);
	});

	it("returns an empty map for an empty/garbage layout", () => {
		expect(parseWindowLayout("").size).toBe(0);
		expect(parseWindowLayout("not-a-layout").size).toBe(0);
	});
});
