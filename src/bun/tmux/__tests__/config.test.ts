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
	setTmuxBeigeTone,
	setTmuxPaneDimming,
	setTmuxPaneTitles,
	tmuxConfigPath,
	tmuxThemeFor,
	TMUX_PANE_DIMMING_OPTION,
	TMUX_PANE_TITLES_OPTION,
	tmuxClientCwd,
	writeTmuxConfigs,
} from "../config";
import { NEW_WINDOW_STATUS_RANGE, STATUS_FORMAT } from "../themes";
import { DEV3_HOME } from "../../paths";

describe("tmux config paths", () => {
	it("uses the isolated test root, defaults to the dark config and switches with the theme", () => {
		expect(tmuxConfigPath("dark", true)).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-dark-dimmed.conf`);
		expect(tmuxConfigPath("light", false)).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-light-undimmed.conf`);
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
	it("puts the window bar on top after the theme sources, for both flavors", () => {
		for (const flavor of ["mocha", "latte"] as const) {
			const config = buildThemeConfig(flavor);
			const position = config.indexOf("set -g status-position top");
			expect(position, flavor).toBeGreaterThan(-1);
			// After every plugin `source` line, so the theme cannot move it back.
			expect(position, flavor).toBeGreaterThan(config.lastIndexOf("source "));
			expect(config).not.toMatch(/status-position bottom/);
		}
	});

	it("draws the + button after the window list and opens a window with the split cwd rule", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain(`set -g 'status-format[0]' '${STATUS_FORMAT}'`);
		const list = STATUS_FORMAT.indexOf("#{W:");
		const button = STATUS_FORMAT.indexOf(`range=user|${NEW_WINDOW_STATUS_RANGE}`);
		// After the list and in tmux's after-list slot: overflow trims tabs, never the button.
		expect(button).toBeGreaterThan(list);
		expect(STATUS_FORMAT.lastIndexOf("#[nolist]", button)).toBeGreaterThan(list);
		expect(button).toBeLessThan(STATUS_FORMAT.indexOf("align=right"));
		expect(config).toContain(
			`bind -n MouseDown1Status if -F '#{==:#{mouse_status_range},${NEW_WINDOW_STATUS_RANGE}}' 'new-window -c "${PANE_CWD_FORMAT}" ; select-window -t "{end}"' 'switch-client -t ='`,
		);
	});

	it("enables Sync, OSC 8 hyperlinks (forced for CLIs), extended keys, focus events and a 250000 history", () => {
		const config = buildThemeConfig("mocha");
		expect(config).toContain("xterm-256color:Sync");
		expect(config).toContain("tmux-256color:Sync");
		expect(config).toContain("xterm-256color:hyperlinks");
		expect(config).toContain("tmux-256color:hyperlinks");
		expect(config).toContain("set-environment -g FORCE_HYPERLINK 1");
		expect(config).toContain("extended-keys on");
		expect(config).toContain("focus-events on");
		expect(config).toContain("terminal-overrides");
		expect(config).toContain("history-limit 250000");
	});

	it("retains scrolled history selections but cancels live-screen copies", () => {
		const config = buildThemeConfig("mocha");
		const copy = "if-shell -F '#{>:#{scroll_position},0}' 'send-keys -X copy-pipe' 'send-keys -X copy-pipe-and-cancel'";
		for (const table of ["copy-mode", "copy-mode-vi"]) {
			expect(config).toContain(`bind -T ${table} MouseDragEnd1Pane ${copy}`);
			// A double- or triple-click is a selection too: a word, a line.
			expect(config).toContain(
				String.raw`bind -T ${table} DoubleClick1Pane select-pane \; send-keys -X select-word \; run-shell -d 0.3 \; ${copy}`,
			);
			expect(config).toContain(
				String.raw`bind -T ${table} TripleClick1Pane select-pane \; send-keys -X select-line \; run-shell -d 0.3 \; ${copy}`,
			);
		}
	});

	it("puts prefix-free pane navigation on Alt+Shift+arrow, frees plain Alt+arrow, and word-deletes on Ctrl+Delete off the alternate screen", () => {
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
			expect(config).toContain("bind -n C-DC if -F '#{alternate_on}' 'send-keys C-DC' 'send-keys M-d'");
		}
	});

	it("user split keys carry an explicit -d (aliases are not yet defined when bind runs) and then focus the new pane", () => {
		const config = buildThemeConfig("mocha");
		// The backslash binding is written with a literal double backslash.
		expect(config).toContain(String.raw`bind \\ split-window -d -h -c "${PANE_CWD_FORMAT}" \; select-pane -R`);
		expect(config).toContain(String.raw`bind | split-window -d -h -c "${PANE_CWD_FORMAT}" \; select-pane -R`);
		expect(config).toContain(String.raw`bind - split-window -d -v -c "${PANE_CWD_FORMAT}" \; select-pane -D`);
		// The stock prefix " and % splits are rebound too: with the alias they would open in the background.
		expect(config).toContain(String.raw`bind '"' split-window -d -v -c "${PANE_CWD_FORMAT}" \; select-pane -D`);
		expect(config).toContain(String.raw`bind % split-window -d -h -c "${PANE_CWD_FORMAT}" \; select-pane -R`);
	});

	it("aliases make every window and split command open in the background", () => {
		for (const flavor of ["mocha", "latte"] as const) {
			const config = buildThemeConfig(flavor);
			expect(config).toContain("set -s command-alias[90] 'new-window=new-window -d'");
			expect(config).toContain("set -s command-alias[91] 'neww=new-window -d'");
			expect(config).toContain("set -s command-alias[92] 'split-window=split-window -d'");
			expect(config).toContain("set -s command-alias[93] 'splitw=split-window -d'");
			// tmux's own split-pane / splitp aliases (indexes 0 and 1) would bypass -d.
			expect(config).toContain("set -s command-alias[0] 'split-pane=split-window -d'");
			expect(config).toContain("set -s command-alias[1] 'splitp=split-window -d'");
		}
	});

	it("selects the requested Catppuccin flavor and never sources the system or user tmux configs", () => {
		for (const flavor of ["mocha", "latte"] as const) {
			const config = buildThemeConfig(flavor);
			expect(config).toContain(`@catppuccin_flavor "${flavor}"`);
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
	it("derives both pane styles from the server option in either default, after the plugin's own styling", () => {
		for (const dimmed of [true, false]) {
			const config = buildThemeConfig("latte", dimmed);
			expect(config).toContain(WINDOW_STYLE_LINE);
			expect(config).toContain(BORDER_STYLE_LINE);
			expect(config.indexOf(WINDOW_STYLE_LINE)).toBeGreaterThan(config.indexOf("catppuccin_tmux.conf"));
		}
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

	it("names and seeds a title-bar variant without renaming the existing files", () => {
		expect(tmuxConfigPath("dark", true)).toBe(tmuxConfigPath("dark", true, false));
		expect(tmuxConfigPath("dark", true, true)).toBe(`${process.env.DEV3_TEST_ROOT}/dev3-tmux-dark-dimmed-titled.conf`);
		writeTmuxConfigs();
		expect(readFileSync(tmuxConfigPath("light", false, true), "utf-8")).toContain(`set -goq ${TMUX_PANE_TITLES_OPTION} on`);
		expect(readFileSync(tmuxConfigPath("light", false, false), "utf-8")).toContain(`set -goq ${TMUX_PANE_TITLES_OPTION} off`);
		try {
			setTmuxPaneTitles(true);
			expect(activeTmuxConfigPath()).toBe(tmuxConfigPath("dark", true, true));
		} finally {
			setTmuxPaneTitles(false);
		}
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
});

describe("beige tmux theme", () => {
	it("maps only the beige preference to the beige palette", () => {
		expect(tmuxThemeFor("beige", "light")).toBe("beige");
		expect(tmuxThemeFor("light", "light")).toBe("light");
		expect(tmuxThemeFor("system", "dark")).toBe("dark");
		expect(tmuxThemeFor(undefined, "light")).toBe("light");
	});

	it("bakes the depth into the inlined palette and the config file name", () => {
		setTmuxBeigeTone({ depth: 0, warmth: 0.5 });
		const light = buildThemeConfig("beige");
		const lightPath = tmuxConfigPath("beige", true);
		setTmuxBeigeTone({ depth: 1, warmth: 0.5 });
		const dark = buildThemeConfig("beige");
		const darkPath = tmuxConfigPath("beige", true);
		setTmuxBeigeTone({ depth: 1, warmth: 0 });
		const neutral = buildThemeConfig("beige");
		expect(light).toContain('set -gq @thm_bg "#fcfbf8"');
		expect(dark).toContain('set -gq @thm_bg "#daccb3"');
		// Neutral keeps the lightness and drops the chroma: an equal-channel grey.
		expect(neutral).toMatch(/set -gq @thm_bg "#(..)\1\1"/);
		expect(light).not.toContain("catppuccin_beige_tmux.conf");
		expect(lightPath).toContain("dev3-tmux-beige0-50-dimmed");
		expect(darkPath).toContain("dev3-tmux-beige100-50-dimmed");
		setTmuxBeigeTone({});
	});
});
