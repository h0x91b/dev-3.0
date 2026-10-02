/**
 * Live-tmux check of the status-bar block of the dev3 config: the bar sits on
 * top and shows only while a session has more than one window. The hooks are
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

import { tmuxStatusBarConfig } from "../config";

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
		writeFileSync(conf, `set -g base-index 1\nset -g renumber-windows on\n${tmuxStatusBarConfig()}`);
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "solo", "sh");
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
});
