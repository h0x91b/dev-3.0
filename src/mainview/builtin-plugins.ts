import type { BuiltinPlugin } from "./plugins/runtime";
import { BUILTIN_BOARD_VIEWS } from "./board-views/builtins";
import { BUILTIN_SETTINGS_SECTIONS_PLUGIN } from "./settings-sections/builtins";
import { BUILTIN_PROJECT_SETTINGS_SECTIONS_PLUGIN } from "./settings-sections/project-builtins";
import { BUILTIN_TASK_HEADER_PLUGIN } from "./task-header/builtins";
import { BUILTIN_COMMANDS_PLUGIN } from "./commands/builtins";
import { BUILTIN_TASK_MENU_PLUGIN } from "./task-menu/builtins";
import { BUILTIN_DESTINATION_BODIES_PLUGIN } from "./destination-bodies/builtins";
import { BUILTIN_TASK_PANELS_PLUGIN } from "./task-panels/builtins";
import { BUILTIN_SIDEBAR_PLUGIN } from "./sidebar/builtins";
import { BUILTIN_TERMINAL_COMPANION_PLUGIN } from "./terminal-companion/builtins";
import { BUILTIN_TASK_MARKERS_PLUGIN } from "./task-markers/builtins";
import { BUILTIN_TERMINAL_LINKS_PLUGIN } from "./terminal-links/builtins";
import { BUILTIN_TERMINAL_TAB_DECORATIONS_PLUGIN } from "./terminal-tab-decorations/builtins";
import { BUILTIN_FILE_MENU_PLUGIN } from "./file-menu/builtins";
import { BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN } from "./terminal-window-menu/builtins";
import { BUILTIN_TIPS_PLUGIN } from "./tips/builtins";

/** Everything dev3 contributes to its own slots, in load order: the app's built-in plugin composition. */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
	...BUILTIN_BOARD_VIEWS,
	BUILTIN_SETTINGS_SECTIONS_PLUGIN,
	BUILTIN_PROJECT_SETTINGS_SECTIONS_PLUGIN,
	BUILTIN_TASK_HEADER_PLUGIN,
	BUILTIN_COMMANDS_PLUGIN,
	BUILTIN_TASK_MENU_PLUGIN,
	BUILTIN_DESTINATION_BODIES_PLUGIN,
	BUILTIN_TASK_PANELS_PLUGIN,
	BUILTIN_SIDEBAR_PLUGIN,
	BUILTIN_TERMINAL_COMPANION_PLUGIN,
	BUILTIN_TASK_MARKERS_PLUGIN,
	BUILTIN_TERMINAL_LINKS_PLUGIN,
	BUILTIN_TERMINAL_TAB_DECORATIONS_PLUGIN,
	BUILTIN_FILE_MENU_PLUGIN,
	BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN,
	BUILTIN_TIPS_PLUGIN,
];
