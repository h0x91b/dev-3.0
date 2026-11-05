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
import { SHELL_INIT_DIR, posixShellPromptEnv, writeShellInit } from "../shell-init";
import { getUserShell } from "../shell-env";
import { CATPPUCCIN_PLUGIN_DIR, NEW_WINDOW_STATUS_RANGE, PANE_ID_BADGE, STATUS_FORMAT, writeCatppuccinPlugin } from "./themes";
import { TMUX_AGENT_PANE_OPTION } from "./constants";

/**
 * Working directory for every spawned tmux CLIENT process (`new-session`,
 * `start-server`, …). The tmux server daemonizes with the cwd of the first
 * client that starts it and keeps it for its whole lifetime. If that cwd is a
 * task worktree, it gets deleted when the task completes — and tmux 3.7 then
 * silently ignores `-c` on every subsequent new-session/split-window, spawning
 * all new panes in the server's (deleted) cwd instead. The pane cwd must
 * always travel via an explicit `-c` flag; the client itself starts here.
 * See decisions/2026/07/04/tmux-server-immortal-cwd.md.
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


/**
 * Session-scoped user option holding the pane id of the last agent pane the user
 * focused. Written by the `after-select-pane` hook, read at hand-off time to route
 * a message to the agent the user was last working in (see resolveAgentPromptTargetPane).
 */
export const TMUX_LAST_AGENT_PANE_OPTION = "@dev3_last_agent_pane";

/**
 * The themed config for one theme and one default dimming and title-bar choice.
 * The choices are part of the NAME: every dev3 process on the machine writes these
 * shared files at import, and a name that ignored them let another process's
 * default overwrite the file this app later sources into the shared server.
 */
export function tmuxConfigPath(theme: "dark" | "light", dimmed: boolean, titled = false): string {
	return dev3TempPath(`dev3-tmux-${theme}-${dimmed ? "dimmed" : "undimmed"}${titled ? "-titled" : ""}.conf`);
}

let activeTheme: "dark" | "light" = "dark";

/**
 * The `dimInactivePanes` preference, pushed in by the host at startup and on
 * every settings save. Held here rather than read from `settings.ts`: this
 * module writes its configs at import time, and importing the settings loader
 * for that would drag the whole settings graph into every module that touches
 * tmux.
 */
let dimInactivePanes = true;

/** The `paneTitles` preference, held here for the same reason as `dimInactivePanes`. */
let paneTitles = false;

/** The config this process sources: its active theme and its own preferences. */
export function activeTmuxConfigPath(): string {
	return tmuxConfigPath(activeTheme, dimInactivePanes, paneTitles);
}

/** Switch the active themed config and return its path. */
export function setActiveTmuxTheme(theme: "dark" | "light"): string {
	activeTheme = theme;
	return activeTmuxConfigPath();
}

// Shared functional settings (not theme-related)
const TMUX_CONFIG_FUNCTIONAL = String.raw`
# System and user tmux configs are deliberately NOT sourced: the dev3 server
# runs exclusively on this config. See decisions/2026/08/02/isolate-tmux-config.md.

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

# OSC 8 hyperlinks — ghostty-web renders them clickable, but tmux forwards
# OSC 8 only to clients whose terminal declares the feature. Requires tmux 3.4+.
set -gqa terminal-features ",xterm-256color:hyperlinks"
set -gqa terminal-features ",tmux-256color:hyperlinks"

# CLIs (Claude Code & friends) gate OSC 8 emission on supports-hyperlinks
# heuristics that never recognize tmux; FORCE_HYPERLINK opts them in.
set-environment -g FORCE_HYPERLINK 1

# Auto-rename windows by running command
setw -g automatic-rename on

# Renumber windows when one is closed
set -g renumber-windows on

# Intuitive splits (open in same directory; fall back to the session's
# start dir — the task worktree — when pane_current_path is unreadable)
bind | split-window -h -c "${PANE_CWD_FORMAT}"
bind \\ split-window -h -c "${PANE_CWD_FORMAT}"
bind - split-window -v -c "${PANE_CWD_FORMAT}"

# Alt+Shift+arrow pane switching (no prefix required). Plain Alt+arrow is
# deliberately NOT bound: the shell and agent TUIs use modifier+arrow for word
# motion, and a root-table binding swallows the key before the pane sees it.
# The unbinds are load-bearing, not cosmetic — configureTmux re-sources this
# file into a LIVE server, where a merely deleted bind line stays in effect.
unbind -n M-Left
unbind -n M-Right
unbind -n M-Up
unbind -n M-Down
bind -n M-S-Left select-pane -L
bind -n M-S-Right select-pane -R
bind -n M-S-Up select-pane -U
bind -n M-S-Down select-pane -D

# Ctrl+Delete deletes the next word (M-d) at a shell or agent prompt; a full-screen
# program on the alternate screen (neovim, vim, nano) gets the raw key it decodes itself.
# See decisions/2026/10/17/terminal-ctrl-backspace-word-delete.md.
bind -n C-DC if -F '#{alternate_on}' 'send-keys C-DC' 'send-keys M-d'

# Remember the last AGENT pane the user focused, per session. Fires on every
# pane selection (mouse, Alt+Shift+arrow, programmatic). The conditional keeps the
# previous value when the newly-focused pane is not an agent pane, so focusing a
# shell / dev-server split never misroutes a hand-off. Read at send time by
# resolveAgentPromptTargetPane. Session-scoped: the dev3 tmux server hosts many
# task sessions, so a global option would let tasks clobber each other's value.
set-hook -g after-select-pane 'set -F ${TMUX_LAST_AGENT_PANE_OPTION} "#{?${TMUX_AGENT_PANE_OPTION},#{pane_id},#{${TMUX_LAST_AGENT_PANE_OPTION}}}"'

# A launchd-started server runs with "tmux -D", which turns exit-empty off; turn it
# back on once a session exists so the server still exits after the last one closes.
# Turning it on before the first session would exit the waiting server at once.
# See decisions/2026/10/26/tmux-server-as-launchd-job.md.
set-hook -g session-created[99] 'set -s exit-empty on'

# Pane border style
set -g pane-border-lines double

# Clipboard support
set -s set-clipboard on

# Retain a scrolled history viewport; a live-screen copy must not hold agent input.
# Explicit bindings also replace old copy-and-cancel on running servers.
bind -T copy-mode MouseDragEnd1Pane if-shell -F '#{>:#{scroll_position},0}' 'send-keys -X copy-pipe' 'send-keys -X copy-pipe-and-cancel'
bind -T copy-mode-vi MouseDragEnd1Pane if-shell -F '#{>:#{scroll_position},0}' 'send-keys -X copy-pipe' 'send-keys -X copy-pipe-and-cancel'

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

/**
 * `$ENV` is the only rc file a POSIX `sh` (dash / busybox ash) reads for an
 * interactive shell, so it is where the dev3 prompt goes. The user's own value
 * travels along as `DEV3_USER_ENV` and the init file sources it first —
 * clobbering `$ENV` outright would silently drop their aliases.
 *
 * Harmless for zsh (ignores `$ENV`) and for bash (reads it only when invoked
 * as `sh`, where the file is valid anyway).
 */
function shellEnvConfig(): string {
	const env = posixShellPromptEnv();
	const userEnv = env.DEV3_USER_ENV ? tmuxConfigValue(env.DEV3_USER_ENV) : null;
	const envLine = tmuxConfigValue(env.ENV);
	return [
		"# Shell prompt — POSIX sh reads $ENV for interactive shells",
		...(userEnv ? [`set-environment -g DEV3_USER_ENV ${userEnv}`] : []),
		...(envLine ? [`set-environment -g ENV ${envLine}`] : []),
		...defaultShellConfig(),
		"",
	].join("\n");
}

/**
 * A path spliced into a tmux config line, quoted. tmux splits a config line into
 * words, so an unquoted value with a space dies with "too many arguments" and a
 * value with a newline becomes a second COMMAND (verified on tmux 3.6a). Single
 * quotes are literal in tmux and have no escape, so a value carrying one — or a
 * newline — is dropped rather than emitted broken.
 */
function tmuxConfigValue(value: string): string | null {
	return /['\r\n]/.test(value) ? null : `'${value}'`;
}

/**
 * Panes dev3 spawns carry their shell explicitly; a pane the USER splits off
 * takes tmux's `default-shell`, which a long-lived server froze at whatever
 * `$SHELL` was when it started — yesterday's zsh, on a machine whose owner has
 * since chosen sh. Naming it here makes sourcing this config repair that.
 *
 * Best-effort: an unreadable shell setting must not stop the tmux config from
 * being written at all.
 */
function defaultShellConfig(): string[] {
	try {
		const shell = getUserShell();
		if (!shell.startsWith("/")) return [];
		const quoted = tmuxConfigValue(shell);
		return quoted ? [`set -g default-shell ${quoted}`] : [];
	} catch {
		return [];
	}
}

// Status bar setup — window tabs, a new-window button, and the focused pane's id on the right
const TMUX_STATUS_BAR = `
# Status bar — window tabs, focused pane id on the right. On top so the window list sits where the
# eye starts: a window opened by Cmd+T or an agent must not hide its task.
set -g status on
set -g status-position top
set -g status-right "${PANE_ID_BADGE}"
set -g status-left ""

# A + button right after the last tab opens a window like Cmd+T: same cwd rule, and
# it selects the new (last) window, since new-window itself stays in the background.
# Any other click keeps tmux's default (switch to the clicked tab).
set -g 'status-format[0]' '${STATUS_FORMAT}'
bind -n MouseDown1Status if -F '#{==:#{mouse_status_range},${NEW_WINDOW_STATUS_RANGE}}' 'new-window -c "${PANE_CWD_FORMAT}" ; select-window -t "{end}"' 'switch-client -t ='

# The bar stays visible with a single window too. Earlier configs hid it through
# these hooks, and re-sourcing never drops a hook on a live server — unset them.
set-hook -gu window-linked
set-hook -gu window-unlinked
set-hook -gu client-attached
set-hook -gu client-session-changed

# A new window never takes the screen on its own: an agent or a script opening
# one must not hide the agent. Explicit user actions switch on purpose — the app
# selects the window it created, and ⌃B c selects the new last window itself.
# Decision: decisions/2026/10/03/new-tmux-windows-open-in-background.md
set -s command-alias[90] 'new-window=new-window -d'
set -s command-alias[91] 'neww=new-window -d'
bind c new-window -c "${PANE_CWD_FORMAT}" \\; select-window -t "{end}"
`;

/**
 * Server-global user option holding the dim-inactive-panes choice (`on`/`off`).
 * It lives in the tmux server, not in the config text, because every dev3
 * instance on the machine shares that server: the last explicit toggle — from
 * any instance — must win, and re-sourcing a config must never undo it.
 */
export const TMUX_PANE_DIMMING_OPTION = "@dev3_pane_dimming";

/**
 * How much an unfocused pane differs from the focused one.
 *
 * Catppuccin's own config darkens every inactive pane so the focused split is
 * obvious; the user can switch that off (`dimInactivePanes`). The config only
 * seeds the server option when it is unset (`-o`), with this process's saved
 * choice, then derives both styles from the option. Always emitted: a line
 * merely omitted on re-source would leave the plugin's dimmed value in effect.
 */
function paneDimConfig(defaultDimmed: boolean): string {
	const off = `#{==:#{${TMUX_PANE_DIMMING_OPTION}},off}`;
	return [
		"",
		"# Inactive pane contrast (Settings → Terminal → Dim inactive panes)",
		`set -goq ${TMUX_PANE_DIMMING_OPTION} ${defaultDimmed ? "on" : "off"}`,
		`set -gF window-style "#{?${off},bg=#{@thm_bg}#,fg=#{@thm_fg},bg=#{@thm_mantle}#,fg=#{@thm_overlay_1}}"`,
		`set -gF pane-border-style "fg=#{@thm_surface_1},bg=#{?${off},#{@thm_bg},#{@thm_mantle}}"`,
		"",
	].join("\n");
}

/**
 * Server-global user option holding the pane-title-bar choice (`on`/`off`), shared
 * across dev3 instances exactly like {@link TMUX_PANE_DIMMING_OPTION}.
 */
export const TMUX_PANE_TITLES_OPTION = "@dev3_pane_titles";

/**
 * Pane label: the title a program set, else `folder │ command` — a plain shell's
 * title is just the hostname, which says nothing.
 */
const PANE_BORDER_LABEL = "#{?#{||:#{||:#{==:#{pane_title},},#{==:#{pane_title},#{host}}},#{==:#{pane_title},#{host_short}}},#{b:pane_current_path} │ #{pane_current_command},#{pane_title}}";

/**
 * One slanted tab per pane, cut like the window tabs (themes.ts `tabCaps`): green
 * while focused, grey otherwise. Styles inside a conditional use spaces, not commas,
 * because a comma would end the branch; caps take only a foreground so they sit on
 * whatever background the border has.
 */
function paneTitleTab(fill: string, text: string, bold: boolean, zoomMarker: string): string {
	return `#[fg=#{${fill}}]\uE0BA#[fg=#{${text}} bg=#{${fill}}${bold ? " bold" : ""}] #{pane_index} ${zoomMarker}${PANE_BORDER_LABEL} #[default]#[fg=#{${fill}}]\uE0BC#[default]`;
}

export const PANE_BORDER_FORMAT = `#{?pane_active,${paneTitleTab("@thm_green", "@thm_crust", true, "#{?window_zoomed_flag,󰁌 ,}")},${paneTitleTab("@thm_surface_1", "@thm_subtext_0", false, "")}}`;

/**
 * Title bars above each pane (Settings → Terminal → Pane title bars). Seeded like
 * the dimming option, then `pane-border-status` follows the option on every source;
 * the `off` branch is what turns the bars off on a live server.
 */
function paneTitlesConfig(defaultOn: boolean): string {
	return [
		"",
		"# Pane title bars (Settings → Terminal → Pane title bars)",
		`set -goq ${TMUX_PANE_TITLES_OPTION} ${defaultOn ? "on" : "off"}`,
		`set -wg pane-border-format "${PANE_BORDER_FORMAT}"`,
		`if -F "#{==:#{${TMUX_PANE_TITLES_OPTION}},on}" "set -wg pane-border-status top" "set -wg pane-border-status off"`,
		"",
	].join("\n");
}

export function buildThemeConfig(flavor: "mocha" | "latte", dimInactivePanes = true, paneTitles = false): string {
	const pluginDir = CATPPUCCIN_PLUGIN_DIR;
	return [
		`# dev3 tmux config — Catppuccin ${flavor}`,
		`set -g @catppuccin_flavor "${flavor}"`,
		// Source palette DIRECTLY (source -F with #{d:current_file} is unreliable)
		`source "${pluginDir}/themes/catppuccin_${flavor}_tmux.conf"`,
		`source "${pluginDir}/catppuccin_options_tmux.conf"`,
		`source "${pluginDir}/catppuccin_tmux.conf"`,
		paneDimConfig(dimInactivePanes),
		paneTitlesConfig(paneTitles),
		TMUX_CONFIG_FUNCTIONAL,
		shellEnvConfig(),
		TMUX_STATUS_BAR,
	].join("\n");
}

export function setTmuxPaneDimming(enabled: boolean): void {
	dimInactivePanes = enabled;
}

export function setTmuxPaneTitles(enabled: boolean): void {
	paneTitles = enabled;
}

/** Hand the saved pane preferences to this module at boot, before any pane spawns. */
export function applySavedTmuxPanePreferences(settings: { dimInactivePanes?: boolean; paneTitles?: boolean }): void {
	setTmuxPaneDimming(settings.dimInactivePanes !== false);
	setTmuxPaneTitles(settings.paneTitles === true);
}

/**
 * Rewrite every themed config — both themes, both dimming variants. Called at
 * startup, and again when a setting the config embeds changes: the shell (baked
 * into `default-shell`), whether inactive panes are dimmed, and pane title bars.
 */
export function writeTmuxConfigs(): void {
	writeShellInit();
	for (const dimmed of [true, false]) {
		for (const titled of [false, true]) {
			writeFileSync(tmuxConfigPath("dark", dimmed, titled), buildThemeConfig("mocha", dimmed, titled));
			writeFileSync(tmuxConfigPath("light", dimmed, titled), buildThemeConfig("latte", dimmed, titled));
		}
	}
}

// Write Catppuccin plugin files + both themed configs + shell init at startup
writeCatppuccinPlugin();
writeTmuxConfigs();
