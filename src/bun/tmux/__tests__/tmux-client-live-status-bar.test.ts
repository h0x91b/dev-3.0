/**
 * Live-tmux check of the full dev3 themed config: it parses, the bar sits on
 * top, stays visible with one window and through window churn, and tabs are slanted. Only a
 * real server proves the config parses and that a re-source drops the old auto-hide hooks.
 * Named to match the `tmux-client-live*` exclusion — runs in `test:full`/CI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildThemeConfig } from "../config";
import { WINDOW_LABEL } from "../themes";
import { TMUX_AGENT_PANE_OPTION, TMUX_TASK_TITLE_OPTION } from "../constants";

function tmuxVersion(): string | null {
	try {
		const version = execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim();
		return /^tmux \d/.test(version) ? version : null;
	} catch {
		return null;
	}
}

const SOCKET = `dev3-live-statusbar-${process.pid}`;

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8" }).trim();
}

/** The session's own `status` value ("" when it only inherits the global one). */
function sessionStatus(session: string): string {
	return tmux("show-options", "-v", "-t", `=${session}:`, "status");
}

/** The `status` value the session actually renders with, inherited or its own. */
function effectiveStatus(session: string): string {
	return tmux("show-options", "-Av", "-t", `=${session}:`, "status");
}

const AUTO_HIDE_HOOKS = ["window-linked", "window-unlinked", "client-attached", "client-session-changed"];

let workDir = "";

describe.skipIf(!tmuxVersion())("dev3 status bar on a live tmux server", () => {
	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "dev3-statusbar-live-"));
		const conf = join(workDir, "status.conf");
		writeFileSync(conf, buildThemeConfig("mocha"));
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "solo", "sh");
		// What an older dev3 config left behind: an auto-hide hook and a hidden lone-window bar.
		tmux("set-hook", "-g", "window-linked", "set -t =solo: status off");
		tmux("set-option", "-t", "=solo:", "status", "off");
		tmux("source-file", conf);
	});

	afterAll(() => {
		try {
			tmux("kill-server");
		} catch { /* already gone */ }
		rmSync(workDir, { recursive: true, force: true });
	});

	it("puts the bar on top", () => {
		expect(tmux("show-options", "-gv", "status-position")).toBe("top");
	});

	it("drops the auto-hide hooks an older config left on the live server", () => {
		// An empty hook prints its bare name; a set one adds `[0] <command>`.
		for (const hook of AUTO_HIDE_HOOKS) {
			expect(tmux("show-hooks", "-g", hook)).toBe(hook);
		}
	});

	it("shows the bar for a new single-window session", () => {
		tmux("new-session", "-d", "-s", "one", "sh");
		expect(sessionStatus("one")).toBe("");
		expect(effectiveStatus("one")).toBe("on");
	});

	it("keeps it on as a second window opens and closes again", () => {
		tmux("new-session", "-d", "-s", "multi", "sh");
		expect(effectiveStatus("multi")).toBe("on");
		tmux("new-window", "-d", "-t", "=multi:", "sh");
		expect(effectiveStatus("multi")).toBe("on");
		tmux("kill-window", "-t", "=multi:1");
		expect(tmux("display-message", "-p", "-t", "=multi:", "#{session_windows}")).toBe("1");
		expect(effectiveStatus("multi")).toBe("on");
		expect(sessionStatus("multi")).toBe("");
	});

	it("keeps it on at both ends of a window moved between sessions", () => {
		tmux("new-window", "-d", "-t", "=one:", "sh");
		tmux("move-window", "-s", "=one:2", "-t", "=multi:");
		expect(effectiveStatus("one")).toBe("on");
		expect(effectiveStatus("multi")).toBe("on");
	});

	it("shows the bar again once a stale per-session off is unset, as dev3 does on attach", () => {
		expect(sessionStatus("solo")).toBe("off");
		tmux("set-option", "-u", "-t", "=solo:", "status");
		expect(effectiveStatus("solo")).toBe("on");
		const second = tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=solo:", "sh");
		tmux("kill-window", "-t", second);
		expect(sessionStatus("solo")).toBe("");
	});

	it("shows only the focused pane's id beside the tabs", () => {
		expect(tmux("show-options", "-gv", "status-left")).toBe("");
		const right = tmux("show-options", "-gv", "status-right");
		expect(right).toContain("#{pane_id}");
		expect(right.match(/,reverse\](\uE0BA|\uE0BC)/g)).toHaveLength(2);
	});

	it("draws slanted tabs", () => {
		expect(tmux("show-options", "-gv", "window-status-separator")).toBe("");
		for (const option of ["window-status-format", "window-status-current-format"]) {
			const format = tmux("show-options", "-gv", option);
			expect(format.startsWith("#[fg=")).toBe(true);
			expect(format).toContain("\uE0BA");
			expect(format).toContain("\uE0BC");
			// Caps must be reverse video, or the renderer's contrast filter recolors them.
			expect(format.match(/,reverse\](\uE0BA|\uE0BC)/g)).toHaveLength(2);
		}
	});

	it("labels a plain shell tab by its command, not the hostname it puts in the title", () => {
		tmux("new-session", "-d", "-s", "label", "sh");
		expect(tmux("display-message", "-p", "-t", "=label:", "#{pane_title}")).toBe(
			tmux("display-message", "-p", "-t", "=label:", "#{host}"),
		);
		const windowName = tmux("display-message", "-p", "-t", "=label:", "#{window_name}");
		expect(tmux("display-message", "-p", "-t", "=label:", WINDOW_LABEL)).toBe(windowName);
	});

	it("keeps a real title and caps it at 32 cells", () => {
		tmux("select-pane", "-t", "=label:", "-T", "✳ A very long agent task title that goes on");
		expect(tmux("display-message", "-p", "-t", "=label:", WINDOW_LABEL)).toBe("✳ A very long agent task title t…");
	});

	it("labels a window holding an agent pane with the task title", () => {
		tmux("new-session", "-d", "-s", "agent", "sh");
		tmux("select-pane", "-t", "=agent:", "-T", "✳ Claude Code");
		// No title yet: the agent's own title stands.
		tmux("set-option", "-p", "-t", "=agent:", TMUX_AGENT_PANE_OPTION, "1");
		expect(tmux("display-message", "-p", "-t", "=agent:", WINDOW_LABEL)).toBe("✳ Claude Code");

		tmux("set-option", "-t", "=agent:", TMUX_TASK_TITLE_OPTION, "Move tmux window bar to top");
		expect(tmux("display-message", "-p", "-t", "=agent:", WINDOW_LABEL)).toBe("Move tmux window bar to top");

		// Focus a shell split in the same window: still the agent's window, still the task title.
		tmux("split-window", "-d", "-t", "=agent:", "sh");
		tmux("select-pane", "-t", "=agent:.2");
		expect(tmux("display-message", "-p", "-t", "=agent:", "#{@dev3_agent}")).toBe("");
		expect(tmux("display-message", "-p", "-t", "=agent:", WINDOW_LABEL)).toBe("Move tmux window bar to top");

		// Another window of the same session without an agent pane keeps its own label.
		tmux("new-window", "-d", "-t", "=agent:", "sh");
		const plain = tmux("display-message", "-p", "-t", "=agent:2", WINDOW_LABEL);
		expect(plain).toBe(tmux("display-message", "-p", "-t", "=agent:2", "#{window_name}"));
	});
});

const INNER = `dev3-live-plus-${process.pid}`;
const OUTER = `dev3-live-plus-outer-${process.pid}`;

function inner(...args: string[]): string {
	return execFileSync("tmux", ["-L", INNER, ...args], { encoding: "utf-8" }).trim();
}
function outer(...args: string[]): string {
	return execFileSync("tmux", ["-L", OUTER, ...args], { encoding: "utf-8" }).trimEnd();
}

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
	for (let i = 0; i < 50; i++) {
		const value = read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}: ${JSON.stringify(read())}`);
}

/**
 * The bar as a real attached client draws it: the dev3 server's client runs in
 * a pane of a second throwaway server, which also delivers the mouse clicks.
 */
describe.skipIf(!tmuxVersion())("dev3 status bar + button on a live tmux server", () => {
	let dir = "";
	let sub = "";
	const bar = () => outer("capture-pane", "-p", "-t", "=outer:").split("\n")[0] ?? "";
	const windows = () => inner("list-windows", "-t", "=click:", "-F", "#{window_index}#{?window_active,*,}").split("\n");
	/**
	 * Left-click at 1-based column `col` of the bar row. tmux reads a second click
	 * within its double-click window as DoubleClick1Status, so clicks are spaced.
	 */
	const click = async (col: number) => {
		await new Promise((r) => setTimeout(r, 400));
		outer("send-keys", "-t", "=outer:", "-l", `\x1b[<0;${col};1M`);
		outer("send-keys", "-t", "=outer:", "-l", `\x1b[<0;${col};1m`);
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "dev3-statusbar-plus-"));
		sub = join(dir, "sub");
		mkdirSync(sub);
		const conf = join(dir, "status.conf");
		writeFileSync(conf, buildThemeConfig("mocha"));
		inner("-f", conf, "new-session", "-d", "-s", "click", "-c", dir, "sh");
		inner("send-keys", "-t", "=click:", `cd '${sub}'`, "Enter");
		outer("-f", "/dev/null", "new-session", "-d", "-s", "outer", "-x", "80", "-y", "5", `tmux -L ${INNER} attach -t click`);
		outer("set-option", "-g", "status", "off");
		await until(bar, (line) => line.includes("+"), "the + button");
	});

	afterAll(() => {
		for (const server of [outer, inner]) {
			try {
				server("kill-server");
			} catch { /* already gone */ }
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens a window in the focused pane's directory, hitting only the button's own cells", async () => {
		const plus = bar().indexOf("+") + 1;
		// Layout: last tab, one gap cell, then the button's cap, " + ", cap.
		await click(plus - 3);
		await new Promise((r) => setTimeout(r, 300));
		expect(windows()).toEqual(["1*"]);

		await click(plus);
		await until(windows, (w) => w.length === 2, "the new window");
		expect(windows()).toEqual(["1", "2*"]);
		const cwd = await until(() => inner("display-message", "-p", "-t", "=click:2", "#{pane_current_path}"), Boolean, "the new pane's cwd");
		expect(realpathSync(cwd)).toBe(realpathSync(sub));

		await click(bar().indexOf("+") + 3);
		await until(windows, (w) => w.length === 3, "a window from the button's right cap");
	}, 15_000);

	it("still switches windows on a tab click", async () => {
		await click(bar().indexOf("1") + 1);
		await until(windows, (w) => w[0] === "1*", "window 1 active");
		expect(windows()).toHaveLength(3);
	}, 15_000);
});
