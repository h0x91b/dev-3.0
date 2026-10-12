/**
 * Live-tmux check of the pane title bars: the config parses, the server option
 * drives `pane-border-status` on every re-source (including back off), and the
 * format renders a pane's number and fallback label. Only a real server proves the
 * `if -F` line and the nested conditionals parse.
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

import { buildThemeConfig, TMUX_PANE_TITLES_OPTION } from "../config";

function tmuxVersion(): string | null {
	try {
		const version = execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim();
		return /^tmux \d/.test(version) ? version : null;
	} catch {
		return null;
	}
}

const SOCKET = `dev3-live-panetitles-${process.pid}`;

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8" }).trim();
}

let workDir = "";
let untitled = "";
let titled = "";

describe.skipIf(!tmuxVersion())("dev3 pane title bars on a live tmux server", () => {
	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "dev3-panetitles-live-"));
		untitled = join(workDir, "untitled.conf");
		titled = join(workDir, "titled.conf");
		writeFileSync(untitled, buildThemeConfig("mocha", true, false));
		writeFileSync(titled, buildThemeConfig("mocha", true, true));
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "titles", "-c", workDir, "sh");
		tmux("split-window", "-t", "=titles:", "-c", workDir, "sh");
	});

	afterAll(() => {
		try {
			tmux("kill-server");
		} catch { /* already gone */ }
		rmSync(workDir, { recursive: true, force: true });
	});

	it("leaves the bars off by default", () => {
		tmux("source-file", untitled);
		expect(tmux("show-options", "-gv", TMUX_PANE_TITLES_OPTION)).toBe("off");
		expect(tmux("show-options", "-wgv", "pane-border-status")).toBe("off");
	});

	it("follows the server option on every re-source, back off included", () => {
		tmux("set-option", "-g", TMUX_PANE_TITLES_OPTION, "on");
		tmux("source-file", untitled);
		expect(tmux("show-options", "-wgv", "pane-border-status")).toBe("top");

		tmux("set-option", "-g", TMUX_PANE_TITLES_OPTION, "off");
		tmux("source-file", titled);
		expect(tmux("show-options", "-wgv", "pane-border-status")).toBe("off");
	});

	it("seeds the titled variant on a server that never chose", () => {
		tmux("set-option", "-gu", TMUX_PANE_TITLES_OPTION);
		tmux("source-file", titled);
		expect(tmux("show-options", "-wgv", "pane-border-status")).toBe("top");
	});

	it("renders the pane number and a folder │ command label when no program set a title", () => {
		const folder = workDir.split("/").pop();
		const lines = tmux("list-panes", "-t", "=titles:", "-F", "#{E:pane-border-format}").split("\n");
		expect(lines).toHaveLength(2);
		lines.forEach((line, i) => {
			expect(line).toContain(` ${i + 1} `);
			expect(line).toContain(`${folder} │ sh`);
		});
		// The focused pane carries the green badge, the other the grey one.
		expect(lines.filter((line) => line.includes("#a6e3a1"))).toHaveLength(1);
	});

	it("prefers the title a program set", () => {
		tmux("select-pane", "-t", "=titles:.1", "-T", "Claude Code");
		const line = tmux("display-message", "-p", "-t", "=titles:.1", "#{E:pane-border-format}");
		expect(line).toContain("Claude Code");
		expect(line).not.toContain("│ sh");
	});
});
