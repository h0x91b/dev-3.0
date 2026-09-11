# Repaint a reconnected tmux viewer with `refresh-client`, not a fake resize

Supersedes the row-nudge half of
[`2026/04/24/defer-initial-capture-pane-on-reconnect.md`](../../../2026/04/24/defer-initial-capture-pane-on-reconnect.md)
(old `041`): its third fix — "row-nudge the resize dance" — is replaced here. The
other two fixes in that record (dropping the capture-pane replay, keying
`TaskTerminal` by `taskId`) still stand.

## Context

Switching to a Codex task with a long conversation made the terminal visibly
scroll the whole transcript from the top to the bottom on every switch.

A reconnected viewer mounts a blank terminal but shares one long-lived
`tmux attach` client, and tmux does not repaint a client whose size did not
change. dev3 forced the repaint by asking for `rows + 1` and then `rows` — a
fake resize whose only purpose was the redraw.

## Investigation

A fake resize does not stop at tmux. tmux resizes the pane, the pane's program
gets SIGWINCH, and codex-cli answers a **height** change by clearing its own
terminal scrollback and re-emitting the entire transcript from its history
cells: `codex-rs/tui/src/app/resize_reflow.rs`, `handle_draw_size_change` —
`should_rebuild_transcript = reflow_needed || height_changed`. Identical in
`rust-v0.153.4` and `rust-v0.154.0`. There is no supported way to turn it off:
the `terminal_resize_reflow` feature flag is stage `removed` (permanently on),
and `tui.terminal_resize_reflow_max_rows` only caps how many rows the rebuild
replays — capping it would throw away the user's scrollback instead.

Measured in an isolated tmux server + isolated `CODEX_HOME`, codex-cli 0.154.0,
one `tmux new-session -A` client on a 120×40 pty (dev3's own topology), 287
transcript rows, output captured with `pipe-pane` (the pane) and the client pty
(the viewer):

| Action | bytes to the viewer | bytes Codex wrote | scrollback clears (`CSI 3J`) |
|---|---|---|---|
| idle 5 s | 0 | 0 | 0 |
| same-size resize | 0 | 0 | 0 |
| row-nudge dance (40→41→40) | 28 742 | 35 504 | 2 |
| single resize + `refresh-client` | 1 560 | 0 | 0 |

So the nudge cost two full transcript rebuilds per task switch, and the rebuild
also re-truncates scrollback to Codex's row cap (1 000 rows for an unidentified
terminal, which is what tmux looks like).

## Decision

- `src/mainview/TerminalView.tsx`: `buildResizeDance` is gone; `buildResizeRequest`
  sends **one** resize message. All three callers (WS open, Hard Reset,
  `visibilitychange`) send one size.
- `src/bun/pty-server.ts`: `applyClientSizes`, tmux same-size branch, calls
  `repaintTmuxClients()` instead of resizing the PTY down a row and back.
- `src/bun/tmux/client.ts`: new typed `listClients` and `refreshClient`;
  `CLIENT_NAME_FORMAT` in `formats.ts`. `refresh-client` only accepts a client
  tty path as its target, so the session's clients are listed first.

## Risks

- Two tmux subprocess spawns on a same-size reconnect (list, then refresh)
  where there used to be none. Once per task switch, not per resize event.
- `refresh-client` repaints the **visible screen** only, which is what the
  jiggle achieved too — it never restored scrollback either.
- A native-backend viewer is untouched: it still repaints from its journal and
  returns before this branch.

## Alternatives considered

- **Cap Codex's replay** (`tui.terminal_resize_reflow_max_rows`). Shrinks the
  visible scroll but truncates the user's scrollback on every switch, and means
  writing to the user's global Codex config.
- **Disable the reflow feature.** Not possible: stage `removed`.
- **Nudge columns instead.** Worse — that is the flicker `041` fixed, and a
  width change rebuilds the transcript as well.
- **Drop the redraw entirely.** Brings back the blank pane `041` documents.
