// Catppuccin tmux plugin — all files inlined as string constants so they
// survive bun bundling without needing fs reads at runtime.
// Source .conf files kept in src/bun/tmux/themes-conf/ for reference.

import { mkdirSync, writeFileSync } from "node:fs";
import { dev3TempPath } from "../temp-paths";
import { TMUX_AGENT_PANE_OPTION, TMUX_TASK_TITLE_OPTION } from "./constants";

// ── Color palettes ──────────────────────────────────────────────────

export const CATPPUCCIN_MOCHA = `# --> Catppuccin (Mocha)
set -gq @thm_bg "#1e1e2e"
set -gq @thm_fg "#cdd6f4"
set -gq @thm_rosewater "#f5e0dc"
set -gq @thm_flamingo "#f2cdcd"
set -gq @thm_pink "#f5c2e7"
set -gq @thm_mauve "#cba6f7"
set -gq @thm_red "#f38ba8"
set -gq @thm_maroon "#eba0ac"
set -gq @thm_peach "#fab387"
set -gq @thm_yellow "#f9e2af"
set -gq @thm_green "#a6e3a1"
set -gq @thm_teal "#94e2d5"
set -gq @thm_sky "#89dceb"
set -gq @thm_sapphire "#74c7ec"
set -gq @thm_blue "#89b4fa"
set -gq @thm_lavender "#b4befe"
set -gq @thm_subtext_1 "#a6adc8"
set -gq @thm_subtext_0 "#bac2de"
set -gq @thm_overlay_2 "#9399b2"
set -gq @thm_overlay_1 "#7f849c"
set -gq @thm_overlay_0 "#6c7086"
set -gq @thm_surface_2 "#585b70"
set -gq @thm_surface_1 "#45475a"
set -gq @thm_surface_0 "#313244"
set -gq @thm_mantle "#181825"
set -gq @thm_crust "#11111b"
`;

export const CATPPUCCIN_LATTE = `# --> Catppuccin (Latte)
set -gq @thm_bg "#eff1f5"
set -gq @thm_fg "#4c4f69"
set -gq @thm_rosewater "#dc8a78"
set -gq @thm_flamingo "#dd7878"
set -gq @thm_pink "#ea76cb"
set -gq @thm_mauve "#8839ef"
set -gq @thm_red "#d20f39"
set -gq @thm_maroon "#e64553"
set -gq @thm_peach "#fe640b"
set -gq @thm_yellow "#df8e1d"
set -gq @thm_green "#40a02b"
set -gq @thm_teal "#179299"
set -gq @thm_sky "#04a5e5"
set -gq @thm_sapphire "#209fb5"
set -gq @thm_blue "#1e66f5"
set -gq @thm_lavender "#7287fd"
set -gq @thm_subtext_1 "#6c6f85"
set -gq @thm_subtext_0 "#5c5f77"
set -gq @thm_overlay_2 "#7c7f93"
set -gq @thm_overlay_1 "#8c8fa1"
set -gq @thm_overlay_0 "#9ca0b0"
set -gq @thm_surface_2 "#acb0be"
set -gq @thm_surface_1 "#bcc0cc"
set -gq @thm_surface_0 "#ccd0da"
set -gq @thm_mantle "#e6e9ef"
set -gq @thm_crust "#dce0e8"
`;

// ── Catppuccin plugin files ─────────────────────────────────────────
// Sourced from https://github.com/catppuccin/tmux (MIT license)

const CATPPUCCIN_OPTIONS = `# Catppuccin options (defaults)
set -ogq @catppuccin_flavor "mocha"
set -ogq @catppuccin_status_background "default"
set -ogq @catppuccin_menu_selected_style "fg=#{@thm_fg},bold,bg=#{@thm_overlay_0}"

# Pane styling
set -ogq @catppuccin_pane_status_enabled "no"
set -ogq @catppuccin_pane_border_status "off"
set -ogqF @catppuccin_pane_border_style "fg=#{@thm_overlay_0}"
set -ogq @catppuccin_pane_active_border_style "##{?pane_in_mode,fg=#{@thm_lavender},##{?pane_synchronized,fg=#{@thm_mauve},fg=#{@thm_lavender}}}"
set -ogq @catppuccin_pane_left_separator "█"
set -ogq @catppuccin_pane_middle_separator "█"
set -ogq @catppuccin_pane_right_separator "█"
set -ogq @catppuccin_pane_color "#{@thm_green}"
set -ogq @catppuccin_pane_background_color "#{@thm_surface_0}"
set -ogq @catppuccin_pane_default_text "##{b:pane_current_path}"
set -ogq @catppuccin_pane_default_fill "number"
set -ogq @catppuccin_pane_number_position "left"

# Window options
set -ogq @catppuccin_window_status_style "basic"
set -ogq @catppuccin_window_text_color "#{@thm_surface_0}"
set -ogq @catppuccin_window_number_color "#{@thm_overlay_2}"
set -ogq @catppuccin_window_text " #T"
set -ogq @catppuccin_window_number "#I"
set -ogq @catppuccin_window_current_text_color "#{@thm_surface_1}"
set -ogq @catppuccin_window_current_number_color "#{@thm_mauve}"
set -ogq @catppuccin_window_current_text " #T"
set -ogq @catppuccin_window_current_number "#I"
set -ogq @catppuccin_window_number_position "left"

# Window flags
set -ogq @catppuccin_window_flags "none"
set -ogq @catppuccin_window_flags_icon_last " 󰖰"
set -ogq @catppuccin_window_flags_icon_current " 󰖯"
set -ogq @catppuccin_window_flags_icon_zoom " 󰁌"
set -ogq @catppuccin_window_flags_icon_mark " 󰃀"
set -ogq @catppuccin_window_flags_icon_silent " 󰂛"
set -ogq @catppuccin_window_flags_icon_activity " 󱅫"
set -ogq @catppuccin_window_flags_icon_bell " 󰂞"
set -ogq @catppuccin_window_flags_icon_format "##{?window_activity_flag,#{E:@catppuccin_window_flags_icon_activity},}##{?window_bell_flag,#{E:@catppuccin_window_flags_icon_bell},}##{?window_silence_flag,#{E:@catppuccin_window_flags_icon_silent},}##{?window_active,#{E:@catppuccin_window_flags_icon_current},}##{?window_last_flag,#{E:@catppuccin_window_flags_icon_last},}##{?window_marked_flag,#{E:@catppuccin_window_flags_icon_mark},}##{?window_zoomed_flag,#{E:@catppuccin_window_flags_icon_zoom},} "

# Status line
set -ogq @catppuccin_status_left_separator ""
set -ogq @catppuccin_status_middle_separator ""
set -ogq @catppuccin_status_right_separator " "
set -ogq @catppuccin_status_connect_separator "yes"
set -ogqF @catppuccin_status_module_text_bg "#{@thm_surface_0}"
`;

const PANE_TITLE_LABEL = "#{?#{||:#{==:#{pane_title},#{host}},#{==:#{pane_title},#{host_short}}},#W,#T}";
const HAS_AGENT_PANE = `#{P:#{?${TMUX_AGENT_PANE_OPTION},1,}}`;
const TASK_TITLE = `#{${TMUX_TASK_TITLE_OPTION}}`;

/**
 * Tab label, capped at 32 cells: the dev3 task title on a window holding an agent
 * pane, else the pane title — or the running command when that title is only the
 * hostname (a plain shell's default).
 */
export const WINDOW_LABEL = `#{=/32/…:#{?#{&&:${HAS_AGENT_PANE},${TASK_TITLE}},${TASK_TITLE},${PANE_TITLE_LABEL}}}`;

/** Left and right slanted caps of a tab filled with palette option `tab`. */
function tabCaps(tab: string): [string, string] {
	const cap = (glyph: string) => `#[fg=#{@thm_mantle},bg=#{${tab}},reverse]${glyph}#[noreverse]`;
	return [cap("\uE0BA"), cap("\uE0BC")];
}

/** The focused pane's id (`%12`), as a slanted badge matching the tabs. */
export const PANE_ID_BADGE = `${tabCaps("@thm_surface_1")[0]}#[fg=#{@thm_subtext_0},bg=#{@thm_surface_1}] #{pane_id} ${tabCaps("@thm_surface_1")[1]}`;

const CATPPUCCIN_MAIN = `# Catppuccin tmux main config — %if blocks removed for reliability
# Note: palette is sourced by the wrapper config before this file

# Status bar background
set -gF @_ctp_status_bg "#{@thm_mantle}"
set -gF status-style "bg=#{@thm_mantle},fg=#{@thm_fg}"

# Messages
set -gF message-style "fg=#{@thm_teal},bg=#{@thm_overlay_0},align=centre"
set -gF message-command-style "fg=#{@thm_teal},bg=#{@thm_overlay_0},align=centre"

# Menu
set -gF menu-selected-style "#{E:@catppuccin_menu_selected_style}"

# Pane background — active pane keeps the theme bg; inactive panes get a darker
# bg and greyed default fg so the focused split is obvious at a glance.
set -gF window-style "bg=#{@thm_mantle},fg=#{@thm_overlay_1}"
set -gF window-active-style "bg=#{@thm_bg},fg=#{@thm_fg}"

# Pane borders — include bg so border area also matches its pane
set -gF pane-border-style "fg=#{@thm_surface_1},bg=#{@thm_mantle}"
set -gF pane-active-border-style "fg=#{@thm_lavender},bg=#{@thm_bg}"

# Popups
set -gF popup-style "bg=#{@thm_bg},fg=#{@thm_fg}"
set -gF popup-border-style "fg=#{@thm_surface_1}"

# Window separators (basic style — just spaces)
set -gq @catppuccin_window_left_separator " "
set -gq @catppuccin_window_middle_separator " "
set -gq @catppuccin_window_right_separator " "
set -ogqF @catppuccin_window_current_left_separator "#{@catppuccin_window_left_separator}"
set -ogqF @catppuccin_window_current_middle_separator "#{@catppuccin_window_middle_separator}"
set -ogqF @catppuccin_window_current_right_separator "#{@catppuccin_window_right_separator}"

# Reset base window styles to default — they override #[...] in the format string
set -g window-status-style default
set -g window-status-current-style default
set -gF window-status-activity-style "bg=#{@thm_lavender},fg=#{@thm_crust}"
set -gF window-status-bell-style "bg=#{@thm_yellow},fg=#{@thm_crust}"

# Window tabs — use -g (NOT -gF!) so #I and #T stay as render-time tokens
# Slanted tabs. Caps are reverse video: the app's contrast filter (ansi-theme-adapt)
# would otherwise recolor a cap whose fg is close to its bg, as a cap's always is.
set -g window-status-separator ""
set -g window-status-format "${tabCaps("@thm_surface_1")[0]}#[fg=#{@thm_subtext_0},bg=#{@thm_surface_1}] #I ${WINDOW_LABEL} ${tabCaps("@thm_surface_1")[1]}"
set -g window-status-current-format "${tabCaps("@thm_mauve")[0]}#[fg=#{@thm_crust},bg=#{@thm_mauve},bold] #I ${WINDOW_LABEL} #[nobold]${tabCaps("@thm_mauve")[1]}"

# Mode style (copy mode highlighting)
set -gF mode-style "bg=#{@thm_surface_0},bold"
set -gF clock-mode-colour "#{@thm_blue}"
`;

// ── Write plugin to /tmp ────────────────────────────────────────────

export const CATPPUCCIN_PLUGIN_DIR = dev3TempPath("dev3-catppuccin");

export function writeCatppuccinPlugin(): void {
	const dir = CATPPUCCIN_PLUGIN_DIR;
	mkdirSync(`${dir}/themes`, { recursive: true });

	// Plugin core
	writeFileSync(`${dir}/catppuccin_options_tmux.conf`, CATPPUCCIN_OPTIONS);
	writeFileSync(`${dir}/catppuccin_tmux.conf`, CATPPUCCIN_MAIN);

	// Palettes
	writeFileSync(`${dir}/themes/catppuccin_mocha_tmux.conf`, CATPPUCCIN_MOCHA);
	writeFileSync(`${dir}/themes/catppuccin_latte_tmux.conf`, CATPPUCCIN_LATTE);
}
