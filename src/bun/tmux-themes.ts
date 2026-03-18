// Catppuccin tmux plugin — all files inlined as string constants so they
// survive bun bundling without needing fs reads at runtime.
// Source .conf files kept in src/bun/tmux-themes/ for reference.

import { mkdirSync, writeFileSync } from "node:fs";

// ── Color palettes ──────────────────────────────────────────────────

export const CATPPUCCIN_MOCHA = `# --> Catppuccin (Mocha)
set -ogq @thm_bg "#1e1e2e"
set -ogq @thm_fg "#cdd6f4"
set -ogq @thm_rosewater "#f5e0dc"
set -ogq @thm_flamingo "#f2cdcd"
set -ogq @thm_pink "#f5c2e7"
set -ogq @thm_mauve "#cba6f7"
set -ogq @thm_red "#f38ba8"
set -ogq @thm_maroon "#eba0ac"
set -ogq @thm_peach "#fab387"
set -ogq @thm_yellow "#f9e2af"
set -ogq @thm_green "#a6e3a1"
set -ogq @thm_teal "#94e2d5"
set -ogq @thm_sky "#89dceb"
set -ogq @thm_sapphire "#74c7ec"
set -ogq @thm_blue "#89b4fa"
set -ogq @thm_lavender "#b4befe"
set -ogq @thm_subtext_1 "#a6adc8"
set -ogq @thm_subtext_0 "#bac2de"
set -ogq @thm_overlay_2 "#9399b2"
set -ogq @thm_overlay_1 "#7f849c"
set -ogq @thm_overlay_0 "#6c7086"
set -ogq @thm_surface_2 "#585b70"
set -ogq @thm_surface_1 "#45475a"
set -ogq @thm_surface_0 "#313244"
set -ogq @thm_mantle "#181825"
set -ogq @thm_crust "#11111b"
`;

export const CATPPUCCIN_LATTE = `# --> Catppuccin (Latte)
set -ogq @thm_bg "#eff1f5"
set -ogq @thm_fg "#4c4f69"
set -ogq @thm_rosewater "#dc8a78"
set -ogq @thm_flamingo "#dd7878"
set -ogq @thm_pink "#ea76cb"
set -ogq @thm_mauve "#8839ef"
set -ogq @thm_red "#d20f39"
set -ogq @thm_maroon "#e64553"
set -ogq @thm_peach "#fe640b"
set -ogq @thm_yellow "#df8e1d"
set -ogq @thm_green "#40a02b"
set -ogq @thm_teal "#179299"
set -ogq @thm_sky "#04a5e5"
set -ogq @thm_sapphire "#209fb5"
set -ogq @thm_blue "#1e66f5"
set -ogq @thm_lavender "#7287fd"
set -ogq @thm_subtext_1 "#6c6f85"
set -ogq @thm_subtext_0 "#5c5f77"
set -ogq @thm_overlay_2 "#7c7f93"
set -ogq @thm_overlay_1 "#8c8fa1"
set -ogq @thm_overlay_0 "#9ca0b0"
set -ogq @thm_surface_2 "#acb0be"
set -ogq @thm_surface_1 "#bcc0cc"
set -ogq @thm_surface_0 "#ccd0da"
set -ogq @thm_mantle "#e6e9ef"
set -ogq @thm_crust "#dce0e8"
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

const CATPPUCCIN_MAIN = `# Catppuccin tmux main config — %if blocks removed for reliability
source -F "#{d:current_file}/themes/catppuccin_#{@catppuccin_flavor}_tmux.conf"

# Status bar background
set -gF @_ctp_status_bg "#{@thm_mantle}"
set -gF status-style "bg=#{@thm_mantle},fg=#{@thm_fg}"

# Status modules
source -F "#{d:current_file}/status/application.conf"
source -F "#{d:current_file}/status/session.conf"

# Messages
set -gF message-style "fg=#{@thm_teal},bg=#{@thm_overlay_0},align=centre"
set -gF message-command-style "fg=#{@thm_teal},bg=#{@thm_overlay_0},align=centre"

# Menu
set -gF menu-selected-style "#{E:@catppuccin_menu_selected_style}"

# Pane background — match theme bg so no white gaps around borders
set -gF window-style "bg=#{@thm_bg}"
set -gF window-active-style "bg=#{@thm_bg}"

# Pane borders — include bg so border area also matches
set -gF pane-border-style "fg=#{@thm_overlay_0},bg=#{@thm_bg}"
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
set -g window-status-format "#[fg=#{@thm_crust},bg=#{@thm_overlay_2}] #I #[fg=#{@thm_fg},bg=#{@thm_surface_0}] #T "
set -g window-status-current-format "#[fg=#{@thm_crust},bg=#{@thm_mauve}] #I #[fg=#{@thm_fg},bg=#{@thm_surface_1}] #T "

# Mode style (copy mode highlighting)
set -gF mode-style "bg=#{@thm_surface_0},bold"
set -gF clock-mode-colour "#{@thm_blue}"
`;

const STATUS_MODULE_UTIL = `# vim:set ft=tmux:
# Pre-resolve icon_bg from module color (uses #{E:} to expand the format ref)
set -gqF "@catppuccin_status_\${MODULE_NAME}_icon_fg" "#{E:@thm_crust}"
set -gqF "@catppuccin_status_\${MODULE_NAME}_text_fg" "#{E:@thm_fg}"
set -gqF "@catppuccin_status_\${MODULE_NAME}_icon_bg" "#{E:@catppuccin_\${MODULE_NAME}_color}"
set -gqF @_ctp_module_text_bg "#{E:@thm_surface_0}"

set -gF "@catppuccin_status_\${MODULE_NAME}" "#[fg=#{@catppuccin_status_\${MODULE_NAME}_icon_bg}]#{@catppuccin_status_left_separator}"
set -agF "@catppuccin_status_\${MODULE_NAME}" "#[fg=#{@catppuccin_status_\${MODULE_NAME}_icon_fg},bg=#{@catppuccin_status_\${MODULE_NAME}_icon_bg}]#{@catppuccin_\${MODULE_NAME}_icon}"
set -agF "@catppuccin_status_\${MODULE_NAME}" "#{@catppuccin_status_middle_separator}"
set -agF "@catppuccin_status_\${MODULE_NAME}" "#[fg=#{@catppuccin_status_\${MODULE_NAME}_text_fg},bg=#{@_ctp_module_text_bg}]"
set -ag "@catppuccin_status_\${MODULE_NAME}" "#{E:@catppuccin_\${MODULE_NAME}_text}"
set -agF "@catppuccin_status_\${MODULE_NAME}" "#[fg=#{@_ctp_module_text_bg}]#{@catppuccin_status_right_separator}"

set -ug @_ctp_module_text_bg
`;

const STATUS_APPLICATION = `# vim:set ft=tmux:
%hidden MODULE_NAME="application"
set -ogq "@catppuccin_\${MODULE_NAME}_icon" " "
set -ogqF "@catppuccin_\${MODULE_NAME}_color" "#{E:@thm_maroon}"
set -ogq "@catppuccin_\${MODULE_NAME}_text" " #{pane_current_command}"
source -F "#{d:current_file}/../utils/status_module.conf"
`;

const STATUS_SESSION = `# vim:set ft=tmux:
%hidden MODULE_NAME="session"
set -ogq "@catppuccin_\${MODULE_NAME}_icon" " "
set -ogq "@catppuccin_\${MODULE_NAME}_color" "#{?client_prefix,#{E:@thm_red},#{E:@thm_green}}"
set -ogq "@catppuccin_\${MODULE_NAME}_text" " #S"
source -F "#{d:current_file}/../utils/status_module.conf"
`;

// ── Write plugin to /tmp ────────────────────────────────────────────

export const CATPPUCCIN_PLUGIN_DIR = "/tmp/dev3-catppuccin";

export function writeCatppuccinPlugin(): void {
	const dir = CATPPUCCIN_PLUGIN_DIR;
	mkdirSync(`${dir}/themes`, { recursive: true });
	mkdirSync(`${dir}/status`, { recursive: true });
	mkdirSync(`${dir}/utils`, { recursive: true });

	// Plugin core
	writeFileSync(`${dir}/catppuccin_options_tmux.conf`, CATPPUCCIN_OPTIONS);
	writeFileSync(`${dir}/catppuccin_tmux.conf`, CATPPUCCIN_MAIN);

	// Palettes
	writeFileSync(`${dir}/themes/catppuccin_mocha_tmux.conf`, CATPPUCCIN_MOCHA);
	writeFileSync(`${dir}/themes/catppuccin_latte_tmux.conf`, CATPPUCCIN_LATTE);

	// Status modules (only application + session are used)
	writeFileSync(`${dir}/status/application.conf`, STATUS_APPLICATION);
	writeFileSync(`${dir}/status/session.conf`, STATUS_SESSION);
	writeFileSync(`${dir}/utils/status_module.conf`, STATUS_MODULE_UTIL);
}
