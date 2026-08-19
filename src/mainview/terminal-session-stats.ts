/**
 * App-session terminal totals, deliberately module-level: every terminal shares
 * ONE ghostty WASM module, so the question a post-mortem asks first is whether one
 * pane broke or the whole module did. Per-pane numbers cannot answer that.
 *
 * Read by `TerminalView` (its own diagnostics) and by `renderer-heartbeat`, which
 * ships them to the backend so a frozen window's last report says how much
 * terminal was on screen when it went quiet.
 */
export const session = { liveTerminals: 0, frameErrorPanes: 0, crashes: 0 };
