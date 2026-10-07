# On a tmux stream, paste brackets do not depend on ghostty's DEC 2004 flag

## Context

h0x91b/dev-3.0#1924: on the tmux backend a multiline paste over ~1 KB reached Claude Code without
`ESC [200~` / `ESC [201~`, so it became an attachment plus typed text (or, in zsh, ran the first
line). `TerminalView` pasted through ghostty's `term.paste()`, which brackets only when ghostty's
own DEC 2004 flag is on — and on tmux that flag is tmux's CLIENT-terminal state, not the pane's.

## Investigation

Measured on tmux 3.6a (dev3's vendored binary and generated config) with a PTY-driven attach
client, a raw-mode pane reader, Claude Code 2.1.292 and Codex 0.160.1:

- tmux sends `ESC [?2004h` to its client exactly once, at attach, whether or not any pane asked for
  it, and never sends `2004l` — not when a pane toggles the mode, not on split/select.
- A resize (the row-nudge dance) and `refresh-client` repaint and re-send mouse modes, but never 2004.
- tmux strips the markers itself for a pane that did not enable 2004 (pane gets the exact bare
  bytes) and forwards them byte-exact to a pane that did.
- A ghostty Terminal loses the flag on construction (remount), RIS and `term.reset()` (Hard Reset).
- `pty-server.ts` discards tmux output while no viewer is connected (`ingestPtyOutput`), and the pty
  URL RPC spawns the attach before the socket joins — so even the first view after app start can
  miss the one `2004h`. Seen live: pre-fix build, first open after restart, Claude Code split.

So in the steady state ghostty's flag is always on under tmux and every paste is bracketed; the bug
is only that the frontend forgets a mode tmux will never resend.

## Decision

`src/mainview/terminal-paste.ts`: `pasteIntoTerminal()` brackets explicitly (through
`term.input(…, true)`, the same onData path `term.paste()` uses) when the stream is tmux and ghostty's
flag is off; otherwise it is `term.paste()` unchanged. `terminalBracketsPaste()` feeds the submit
helper the same answer, so wrap and Enter timing never disagree — the immediate-Enter steady state.
`TerminalView` marks a stream as tmux on the first bare (unframed) socket message; a native session
frames every message (`flushPendingData`), so it is never marked. Covered by
`paste-after-remount-e2e.test.ts` (real ghostty + real tmux) and the wiring tests in
`TerminalView.test.tsx`.

## Risks

- Before the socket has delivered anything, the old behavior stands. Seen once in about ten full
  browser-page reloads: the old page's socket still pinned the client size, the row nudge changed
  nothing, tmux sent no redraw, and the screen stayed blank — a separate, pre-existing problem.
- Relies on tmux 3.x stripping markers for non-2004 panes. Verified on 3.6a here; the e2e test also
  runs on CI's Linux tmux. A tmux that did not strip would type literal `[200~` into such apps.

## Alternatives considered

- Fresh `tmux attach` per reconnect, or forcing tmux to re-send modes: a lifecycle change to the
  shared attach process; `refresh-client` was measured not to re-send 2004 anyway.
- Writing `ESC [?2004h` into ghostty after RIS/reset: forces an emulator mode, and still misses the
  output dropped before the viewer connected.
- Bracketing on every backend: types literal markers into native apps that never asked.
