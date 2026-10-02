// Default tmux socket name — all dev3 sessions live here. Every tmux
// invocation in the app goes through TmuxClient, which always passes
// `-L <socket>` so dev3 sessions never mix with the user's personal server.
export const DEFAULT_TMUX_SOCKET = "dev3";

// Bounded history for a point-in-time pane capture (`capture-pane -S`). Big
// enough that a burst is fully readable, small enough that no caller can pull an
// unbounded transcript.
export const CAPTURE_SCROLLBACK_START_LINE = -3000;

/**
 * Pane-scoped user option (value "1") marking a pane as an AI-agent pane. The app
 * sets it on every agent pane; the focus hook below reads it to remember which
 * agent pane the user last focused. `pane_current_command` is useless for this —
 * an agent constantly spawns children — so the marker is the reliable signal.
 */
export const TMUX_AGENT_PANE_OPTION = "@dev3_agent";

/**
 * Session-scoped user option holding the dev3 task title. The app writes it when a
 * task terminal attaches and whenever the title changes; the window label shows it
 * on any window that holds an agent pane.
 */
export const TMUX_TASK_TITLE_OPTION = "@dev3_task_title";
