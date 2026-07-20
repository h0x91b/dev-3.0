/**
 * The dev3 tmux module — the ONLY place allowed to talk to the tmux binary.
 *
 * - client.ts      TmuxClient + the `tmux` singleton (typed subcommands)
 * - formats.ts     typed `-F` format declarations + the one output parser
 * - session-names.ts  dev3 session naming + reverse parser
 * - binary.ts      binary selection + PATH-shim management (internal;
 *                  reachable only via the client's typed surface)
 * - config.ts      bundled tmux config generator + client-cwd policy
 * - themes.ts      Catppuccin plugin payload
 * - alt-click.ts   pure logic for the Alt/Option-click cursor-move gesture
 * - errors.ts      TmuxError / TmuxSpawnError
 *
 * HARD RULE: never spawn `tmux` directly outside this module — always go
 * through the `tmux` client (see AGENTS.md).
 */
export { tmux, TmuxClient } from "./client";
export type { TmuxClientOptions, SplitOrientation, TmuxLayoutName } from "./client";
export { DEFAULT_TMUX_SOCKET } from "./constants";
export { TmuxError, isTmuxError, TmuxSpawnError, isTmuxSpawnError } from "./errors";
export {
	tmuxFormat,
	parseWindowLayout,
	TMUX_FORMAT_SEPARATOR,
	PANE_ID_FORMAT,
	PANE_PID_FORMAT,
	ALL_PANE_PIDS_FORMAT,
	PANE_START_COMMAND_FORMAT,
	PANE_CURRENT_COMMAND_FORMAT,
	PANE_IN_MODE_FORMAT,
	WINDOW_OVERVIEW_FORMAT,
	PANE_GEOMETRY_FORMAT,
	PANE_SWITCHER_FORMAT,
	WINDOW_SWITCHER_FORMAT,
	SEARCH_STATE_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	STATUS_GEOMETRY_FORMAT,
	ALT_CLICK_PANE_FORMAT,
} from "./formats";
export type { TmuxFormat, TmuxFormatRow } from "./formats";
export {
	taskSessionName,
	projectTerminalSessionName,
	devServerSessionName,
	cleanupSessionName,
	devServerSessionForTaskSession,
	parseDev3SessionName,
	sessionShortId,
	TASK_SESSION_PREFIX,
	PROJECT_TERMINAL_SESSION_PREFIX,
	DEV_SERVER_SESSION_PREFIX,
	CLEANUP_SESSION_PREFIX,
} from "./session-names";
export type { Dev3SessionKind, ParsedDev3SessionName } from "./session-names";
export {
	tmuxClientCwd,
	PANE_CWD_FORMAT,
	TMUX_CONF_DARK_PATH,
	TMUX_CONF_LIGHT_PATH,
	activeTmuxConfigPath,
	setActiveTmuxTheme,
} from "./config";
export {
	findAltClickPane,
	altClickIneligibleReason,
	computeAltClickKeys,
	validAltClickPanes,
	parseAltClickPanes,
	isShellCommand,
} from "./alt-click";
export type { AltClickPane } from "./alt-click";
