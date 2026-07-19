/**
 * Bundled tmux configuration, moved from pty-server.ts.
 *
 * Two theme-specific configs are written at module load: dark and light.
 * Each sets @catppuccin_flavor, sources the Catppuccin plugin for styling,
 * then applies our functional settings (keybindings, scrollback, etc.).
 *
 * Note for keymap.ts / the Keyboard Shortcuts overlay: the terminal `⌃B`
 * prefix bindings documented on the overlay's Terminal tab live in
 * TMUX_CONFIG_FUNCTIONAL below.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { DEV3_HOME } from "../paths";
import { dev3TempPath } from "../temp-paths";
import { SHELL_INIT_DIR, writeShellInit } from "../shell-init";
import { CATPPUCCIN_PLUGIN_DIR, writeCatppuccinPlugin } from "./themes";

/**
 * Working directory for every spawned tmux CLIENT process (`new-session`,
 * `start-server`, …). The tmux server daemonizes with the cwd of the first
 * client that starts it and keeps it for its whole lifetime. If that cwd is a
 * task worktree, it gets deleted when the task completes — and tmux 3.7 then
 * silently ignores `-c` on every subsequent new-session/split-window, spawning
 * all new panes in the server's (deleted) cwd instead. The pane cwd must
 * always travel via an explicit `-c` flag; the client itself starts here.
 * See decisions/103-tmux-server-immortal-cwd.md.
 */
export function tmuxClientCwd(): string {
	try {
		mkdirSync(DEV3_HOME, { recursive: true });
	} catch { /* already exists or unwritable — spawn falls back below */ }
	return DEV3_HOME;
}

/**
 * Working directory format for split-window / new-window `-c` flags.
 * tmux 3.7 on macOS sometimes reports an EMPTY `pane_current_path` for a live
 * pane (the foreground process's cwd is unreadable). A bare
 * `#{pane_current_path}` then expands to "", and tmux falls back to the split
 * CLIENT's cwd — for RPC-spawned clients that's the app bundle directory, so
 * the new pane opens inside the .app. Fall back to `#{session_path}`, which
 * dev3 always sets to the task worktree via `new-session -c`.
 */
export const PANE_CWD_FORMAT = "#{?pane_current_path,#{pane_current_path},#{session_path}}";

export const TMUX_CONF_DARK_PATH = dev3TempPath("dev3-tmux-dark.conf");
export const TMUX_CONF_LIGHT_PATH = dev3TempPath("dev3-tmux-light.conf");

/** Path currently loaded — switched by setActiveTmuxTheme() on theme change. */
let activeConfigPath = TMUX_CONF_DARK_PATH;

export function activeTmuxConfigPath(): string {
	return activeConfigPath;
}

/** Switch the active themed config and return its path. */
export function setActiveTmuxTheme(theme: "dark" | "light"): string {
	activeConfigPath = theme === "light" ? TMUX_CONF_LIGHT_PATH : TMUX_CONF_DARK_PATH;
	return activeConfigPath;
}

// Shared functional settings (not theme-related)
const TMUX_CONFIG_FUNCTIONAL = String.raw`
# Source system and user tmux configs first, so personal keybindings
# and preferences are preserved. Our settings below override as needed.
if-shell "test -f /etc/tmux.conf" "source-file /etc/tmux.conf"
if-shell "test -f ~/.tmux.conf" "source-file ~/.tmux.conf"
if-shell "test -f ~/.config/tmux/tmux.conf" "source-file ~/.config/tmux/tmux.conf"

# Mouse support
setw -g mouse on

# Window/pane numbering starts at 1
set -g base-index 1
setw -g pane-base-index 1

# 256-color terminal with true-color (RGB) override
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:RGB"

# Scrollback buffer — 250k to handle high-output AI agents (Claude Code
# generates 4000+ scroll events/sec; the default 2000 fills in <1 second)
set -g history-limit 250000

# No escape delay — critical for responsiveness. tmux's default 500ms wait
# after Escape makes AI agent TUIs feel sluggish.
set -sg escape-time 0

# Extended keys and focus events — required for proper key handling in
# modern TUI apps (Ink/React-based renderers, neovim, etc.)
set -g extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -g focus-events on

# Synchronized output (DEC mode 2026) — tells the outer terminal to buffer
# all output and render atomically, eliminating screen tearing during rapid
# updates from AI agents. Requires tmux 3.3+.
set -gqa terminal-features ",xterm-256color:Sync"
set -gqa terminal-features ",tmux-256color:Sync"

# Auto-rename windows by running command
setw -g automatic-rename on

# Renumber windows when one is closed
set -g renumber-windows on

# Intuitive splits (open in same directory; fall back to the session's
# start dir — the task worktree — when pane_current_path is unreadable)
bind | split-window -h -c "${PANE_CWD_FORMAT}"
bind \\ split-window -h -c "${PANE_CWD_FORMAT}"
bind - split-window -v -c "${PANE_CWD_FORMAT}"

# Alt+arrow pane switching (no prefix required)
bind -n M-Left select-pane -L
bind -n M-Right select-pane -R
bind -n M-Up select-pane -U
bind -n M-Down select-pane -D

# Pane border style
set -g pane-border-lines double

# Clipboard support
set -s set-clipboard on

# Copy mouse selections without leaving copy-mode. The default
# copy-pipe-and-cancel binding returns the viewport to live output.
bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection

# Bell pass-through
set -g visual-bell off
set -g bell-action any
setw -g monitor-bell on

# Allow escape sequence passthrough (for DEC 2026 synchronized output,
# image protocols like Kitty graphics, etc.)
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM

# Shell prompt — redirect zsh to dev3 ZDOTDIR for short worktree paths
set-environment -g ZDOTDIR ${SHELL_INIT_DIR}
`;

// Status bar setup — references Catppuccin status modules built by the plugin
const TMUX_STATUS_BAR = `
# Status bar — Catppuccin modules
set -g status-right-length 100
set -g status-right "#{E:@catppuccin_status_application}#{E:@catppuccin_status_session}"
set -g status-left ""
`;

export function buildThemeConfig(flavor: "mocha" | "latte"): string {
	const pluginDir = CATPPUCCIN_PLUGIN_DIR;
	return [
		`# dev3 tmux config — Catppuccin ${flavor}`,
		`set -g @catppuccin_flavor "${flavor}"`,
		// Source palette DIRECTLY (source -F with #{d:current_file} is unreliable)
		`source "${pluginDir}/themes/catppuccin_${flavor}_tmux.conf"`,
		`source "${pluginDir}/catppuccin_options_tmux.conf"`,
		`source "${pluginDir}/catppuccin_tmux.conf"`,
		TMUX_CONFIG_FUNCTIONAL,
		TMUX_STATUS_BAR,
	].join("\n");
}

// Write Catppuccin plugin files + both themed configs + shell init at startup
writeCatppuccinPlugin();
writeShellInit();
writeFileSync(TMUX_CONF_DARK_PATH, buildThemeConfig("mocha"));
writeFileSync(TMUX_CONF_LIGHT_PATH, buildThemeConfig("latte"));
