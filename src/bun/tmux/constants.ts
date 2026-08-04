// Default tmux socket name — all dev3 sessions live here. Every tmux
// invocation in the app goes through TmuxClient, which always passes
// `-L <socket>` so dev3 sessions never mix with the user's personal server.
export const DEFAULT_TMUX_SOCKET = "dev3";

// Bounded history for a point-in-time pane capture (`capture-pane -S`). Big
// enough that a burst is fully readable, small enough that no caller can pull an
// unbounded transcript.
export const CAPTURE_SCROLLBACK_START_LINE = -3000;
