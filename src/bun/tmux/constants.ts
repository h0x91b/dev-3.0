// Default tmux socket name — all dev3 sessions live here. Every tmux
// invocation in the app goes through TmuxClient, which always passes
// `-L <socket>` so dev3 sessions never mix with the user's personal server.
export const DEFAULT_TMUX_SOCKET = "dev3";
