import { describe, it, expect, vi } from "vitest";

// Keep module-load side effects (Catppuccin plugin + themed config writes)
// out of the real filesystem sandbox noise; the content is asserted through
// the exported buildThemeConfig instead of intercepted writes.
vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { readFileSync, writeFileSync } from "node:fs";

import {
	activeTmuxConfigPath,
	setActiveTmuxTheme,
	buildThemeConfig,
	PANE_CWD_FORMAT,
	setTmuxPaneDimming,
	tmuxConfigPath,
	TMUX_PANE_DIMMING_OPTION,
	tmuxClientCwd,
	writeTmuxConfigs,
} from "../config";
import { DEV3_HOME } from "../../paths";

describe("tmux config paths", () => {
	it("uses the isolated test root for the themed configs", () => {
		expect(tmuxConfigPath("dark", true)).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-dark-dimmed.conf`);
		expect(tmuxConfigPath("light", false)).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-light-undimmed.conf`);
	});

	it("defaults to the dark config and switches with the theme", () => {
		expect(activeTmuxConfigPath()).toBe(tmuxConfigPath("dark", true));
		expect(setActiveTmuxTheme("light")).toBe(tmuxConfigPath("light", true));
		expect(activeTmuxConfigPath()).toBe(tmuxConfigPath("light", true));
		expect(setActiveTmuxTheme("dark")).toBe(tmuxConfigPath("dark", true));
		expect(activeTmuxConfigPath()).toBe(tmuxConfigPath("dark", true));
	});

	it("follows the dimming preference, so another process's default cannot share its file", () => {
		try {
			setTmuxPaneDimming(false);
			expect(activeTmuxConfigPath()).toBe(tmuxConfigPath("dark", false));
			expect(tmuxConfigPath("dark", false)).not.toBe(tmuxConfigPath("dark", true));
		} finally {
			setTmuxPaneDimming(true);
		}
	});

	it("tmuxClientCwd points at the immortal DEV3_HOME (decision 103)", () => {
		expect(tmuxClientCwd()).toBe(DEV3_HOME);
	});
});

describe("buildThemeConfig", () => {
	it.each(["mocha", "latte"] as const)("puts the window bar on top after the theme sources (%s)", (flavor) => {
		const config = buildThemeConfig(flavor);
		const position = config.indexOf("set -g status-position top");
		expect(position).toBeGreaterThan(-1);
		// After every plugin `source` line, so the theme cannot move it back.
		expect(position).toBeGreaterThan(config.lastIndexOf("source "));
		expect(config).not.toMatch(/status-position bottom/);
	});

	it("includes synchronized output (Sync) terminal features", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain("xterm-256color:Sync");
		expect(config).toContain("tmux-256color:Sync");
	});

	it("forwards OSC 8 hyperlinks and forces their emission by CLIs", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain("xterm-256color:hyperlinks");
		expect(config).toContain("tmux-256color:hyperlinks");
		expect(config).toContain("set-environment -g FORCE_HYPERLINK 1");
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

	it("puts prefix-free pane navigation on Alt+Shift+arrow and frees plain Alt+arrow", () => {
		for (const flavor of ["mocha", "latte"] as const) {
			const config = buildThemeConfig(flavor);
			for (const dir of [
				["Left", "-L"],
				["Right", "-R"],
				["Up", "-U"],
				["Down", "-D"],
			] as const) {
				expect(config).toContain(`bind -n M-S-${dir[0]} select-pane ${dir[1]}`);
				// The unbind is required: configureTmux re-sources this config into a
				// live server, where a merely deleted bind line stays in effect.
				expect(config).toContain(`unbind -n M-${dir[0]}`);
				expect(config).not.toContain(`bind -n M-${dir[0]} select-pane`);
			}
		}
	});

	it("writes a backslash split binding with a literal double backslash", () => {
		expect(buildThemeConfig("mocha")).toContain(
			String.raw`bind \\ split-window -h -c "${PANE_CWD_FORMAT}"`,
		);
	});

	it("never sources the system or user tmux configs", () => {
		for (const flavor of ["mocha", "latte"] as const) {
			const config = buildThemeConfig(flavor);
			expect(config).not.toContain("/etc/tmux.conf");
			expect(config).not.toContain("~/.tmux.conf");
			expect(config).not.toContain("~/.config/tmux/tmux.conf");
		}
	});

	// The Catppuccin plugin dims inactive panes itself, so the override has to be
	// sourced AFTER it — and both states must emit the lines, because these configs
	// are re-sourced into a live server where an omitted line keeps its old value.
	const WINDOW_STYLE_LINE =
		'set -gF window-style "#{?#{==:#{@dev3_pane_dimming},off},bg=#{@thm_bg}#,fg=#{@thm_fg},bg=#{@thm_mantle}#,fg=#{@thm_overlay_1}}"';
	const BORDER_STYLE_LINE =
		'set -gF pane-border-style "fg=#{@thm_surface_1},bg=#{?#{==:#{@dev3_pane_dimming},off},#{@thm_bg},#{@thm_mantle}}"';

	it("seeds the server-wide dimming choice only when the server has none", () => {
		expect(buildThemeConfig("mocha")).toContain(`set -goq ${TMUX_PANE_DIMMING_OPTION} on`);
		expect(buildThemeConfig("mocha", false)).toContain(`set -goq ${TMUX_PANE_DIMMING_OPTION} off`);
		// A forcing `set -g` here would let any re-source — another instance's
		// startup, a PTY spawn, a theme switch — undo the last explicit toggle.
		expect(buildThemeConfig("mocha", false)).not.toMatch(/set -g @dev3_pane_dimming/);
	});

	// The styles must follow the server option, not this process's preference:
	// the text is then identical whichever instance sources it.
	it("derives both pane styles from the server option in either default", () => {
		for (const dimmed of [true, false]) {
			const config = buildThemeConfig("latte", dimmed);
			expect(config).toContain(WINDOW_STYLE_LINE);
			expect(config).toContain(BORDER_STYLE_LINE);
		}
	});

	it("overrides the plugin's own pane styling rather than being overridden by it", () => {
		const config = buildThemeConfig("latte", false);
		expect(config.indexOf(WINDOW_STYLE_LINE)).toBeGreaterThan(config.indexOf("catppuccin_tmux.conf"));
	});

	it("writes both default variants for both themes, whatever this process prefers", () => {
		for (const preference of [false, true]) {
			setTmuxPaneDimming(preference);
			writeTmuxConfigs();
			for (const theme of ["dark", "light"] as const) {
				expect(readFileSync(tmuxConfigPath(theme, false), "utf-8")).toContain(`set -goq ${TMUX_PANE_DIMMING_OPTION} off`);
				expect(readFileSync(tmuxConfigPath(theme, true), "utf-8")).toContain(`set -goq ${TMUX_PANE_DIMMING_OPTION} on`);
			}
		}
		setTmuxPaneDimming(true);
		writeTmuxConfigs();
	});

	// The regression: a second dev3 process imports this module with the default
	// (dimmed) preference and rewrites the shared files. The file THIS process
	// sources must still carry its own default.
	it("keeps an undimmed process's config intact when another process writes the dimmed default", () => {
		try {
			setTmuxPaneDimming(false);
			writeTmuxConfigs();
			const mine = activeTmuxConfigPath();
			writeFileSync(tmuxConfigPath("dark", true), buildThemeConfig("mocha", true));
			expect(readFileSync(mine, "utf-8")).toContain(`set -goq ${TMUX_PANE_DIMMING_OPTION} off`);
		} finally {
			setTmuxPaneDimming(true);
			writeTmuxConfigs();
		}
	});

	it("selects the requested Catppuccin flavor", () => {
		expect(buildThemeConfig("mocha")).toContain('@catppuccin_flavor "mocha"');
		expect(buildThemeConfig("latte")).toContain('@catppuccin_flavor "latte"');
	});
});
