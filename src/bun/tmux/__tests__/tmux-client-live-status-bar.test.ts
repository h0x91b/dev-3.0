/**
 * Live-tmux check of the full dev3 themed config: it parses, the bar sits on
 * top, shows only while a session has more than one window, and tabs are slanted. The hooks are
 * tmux command strings with two levels of quoting and deferred `##` formats,
 * so only a real server proves they parse and target the right session.
 * Named to match the `tmux-client-live*` exclusion — runs in `test:full`/CI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildThemeConfig } from "../config";
import { WINDOW_LABEL } from "../themes";

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

let workDir = "";

describe.skipIf(!tmuxVersion())("dev3 status bar on a live tmux server", () => {
	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "dev3-statusbar-live-"));
		const conf = join(workDir, "status.conf");
		writeFileSync(conf, buildThemeConfig("mocha"));
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "solo", "sh");
		tmux("source-file", conf);
		// Session "solo" predates the config, so its bar is whatever tmux defaulted to.
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

	it("hides the bar for a new single-window session", () => {
		tmux("new-session", "-d", "-s", "one", "sh");
		expect(sessionStatus("one")).toBe("off");
	});

	it("shows it once a second window opens, and only in that session", () => {
		tmux("new-session", "-d", "-s", "multi", "sh");
		tmux("new-window", "-d", "-t", "=multi:", "sh");
		expect(sessionStatus("multi")).toBe("on");
		expect(sessionStatus("one")).toBe("off");
	});

	it("hides it again when the session is back to one window", () => {
		tmux("kill-window", "-t", "=multi:1");
		expect(tmux("display-message", "-p", "-t", "=multi:", "#{session_windows}")).toBe("1");
		expect(sessionStatus("multi")).toBe("off");
	});

	it("follows a window moved between sessions on both ends", () => {
		tmux("new-window", "-d", "-t", "=one:", "sh");
		expect(sessionStatus("one")).toBe("on");
		tmux("move-window", "-s", "=one:2", "-t", "=multi:");
		expect(sessionStatus("one")).toBe("off");
		expect(sessionStatus("multi")).toBe("on");
	});

	it("shows nothing beside the tabs", () => {
		expect(tmux("show-options", "-gv", "status-left")).toBe("");
		expect(tmux("show-options", "-gv", "status-right")).toBe("");
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

	it("keeps a real title and caps it at 22 cells", () => {
		tmux("select-pane", "-t", "=label:", "-T", "✳ A very long agent task title");
		expect(tmux("display-message", "-p", "-t", "=label:", WINDOW_LABEL)).toBe("✳ A very long agent ta…");
	});
});
