import { describe, it, expect, vi } from "vitest";

// Keep module-load side effects (Catppuccin plugin + themed config writes)
// out of the real filesystem sandbox noise; the content is asserted through
// the exported buildThemeConfig instead of intercepted writes.
vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	TMUX_CONF_DARK_PATH,
	TMUX_CONF_LIGHT_PATH,
	activeTmuxConfigPath,
	setActiveTmuxTheme,
	buildThemeConfig,
	PANE_CWD_FORMAT,
	tmuxClientCwd,
} from "../config";
import { DEV3_HOME } from "../../paths";

describe("tmux config paths", () => {
	it("uses the isolated test root for the themed configs", () => {
		expect(TMUX_CONF_DARK_PATH).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-dark.conf`);
		expect(TMUX_CONF_LIGHT_PATH).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-light.conf`);
	});

	it("defaults to the dark config and switches with the theme", () => {
		expect(activeTmuxConfigPath()).toBe(TMUX_CONF_DARK_PATH);
		expect(setActiveTmuxTheme("light")).toBe(TMUX_CONF_LIGHT_PATH);
		expect(activeTmuxConfigPath()).toBe(TMUX_CONF_LIGHT_PATH);
		expect(setActiveTmuxTheme("dark")).toBe(TMUX_CONF_DARK_PATH);
		expect(activeTmuxConfigPath()).toBe(TMUX_CONF_DARK_PATH);
	});

	it("tmuxClientCwd points at the immortal DEV3_HOME (decision 103)", () => {
		expect(tmuxClientCwd()).toBe(DEV3_HOME);
	});
});

describe("buildThemeConfig", () => {
	it("includes synchronized output (Sync) terminal features", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain("xterm-256color:Sync");
		expect(config).toContain("tmux-256color:Sync");
	});

	it("includes extended-keys and focus-events settings", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain("extended-keys on");
		expect(config).toContain("focus-events on");
		expect(config).toContain("terminal-overrides");
	});

	it("sets history-limit to 250000", () => {
		expect(buildThemeConfig("mocha")).toContain("history-limit 250000");
	});

	it("pins mouse copies to the default copy-pipe-and-cancel binding", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain(
			"bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
		);
		expect(config).toContain(
			"bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
		);
		expect(config).not.toContain("MouseDragEnd1Pane send-keys -X copy-selection");
	});

	it("writes a backslash split binding with a literal double backslash", () => {
		expect(buildThemeConfig("mocha")).toContain(
			String.raw`bind \\ split-window -h -c "${PANE_CWD_FORMAT}"`,
		);
	});

	it("selects the requested Catppuccin flavor", () => {
		expect(buildThemeConfig("mocha")).toContain('@catppuccin_flavor "mocha"');
		expect(buildThemeConfig("latte")).toContain('@catppuccin_flavor "latte"');
	});
});
