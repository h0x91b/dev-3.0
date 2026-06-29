# 093 — Alt/Option-click to move the terminal cursor

## Context
iTerm2-style "Option-click to move the cursor": alt-clicking a cell in a plain
shell/readline prompt should walk the text cursor there. Claude Code ships its own
alt-click move, so the gesture must stay out of its way (and any other TUI that owns
the mouse). The v1 attempt gated purely on `term.hasMouseTracking()` in the renderer
— and did not work at all in practice.

## Investigation
- **Why renderer-side gating is impossible:** dev3's tmux runs with `mouse on`
  (`pty-server.ts` config), and tmux enables SGR mouse tracking on the OUTER terminal
  for the entire session. Verified empirically: attaching a scripted client to a
  `mouse on` tmux emits `\x1b[?1000h`, `\x1b[?1002h`, `\x1b[?1006h` immediately — so
  `hasMouseTracking()` is `true` even at an idle zsh prompt, and a `!hasMouseTracking()`
  gate never fires. The renderer fundamentally cannot tell a shell pane from a TUI pane.
- **What tmux knows:** `list-panes -F` exposes per-pane `pane_current_command` (zsh vs
  node/vim/htop), geometry (`pane_left/top/width/height`), `pane_in_mode` (copy-mode),
  `cursor_x/cursor_y` (pane-relative), `window_zoomed_flag`.
- **Arrows do move the shell cursor:** verified end-to-end — `send-keys -t <pane> Left ×5`
  moves `#{cursor_x}` by exactly −5 in a live zsh; `capture-pane -p -S y -E y` returns the
  row text (used to clamp the target to end-of-input).
- **Listener race (unchanged from v1):** ghostty's text-selection `mousedown` sits on the
  canvas in the bubble phase, registered before our handlers, without checking
  `defaultPrevented` — only capture on an ancestor deterministically pre-empts it.
- **Modifier stripping:** the SGR bridge in `setupMouseTracking` encoded bare `e.button`,
  silently dropping Alt — so Claude Code never received a real M-click and its built-in
  alt-click could not work through dev3.

## Decision
Two-level gating, decision logic on the backend:
- **Renderer** (`TerminalView.tsx`, capture-phase `mousedown` on the canvas parent):
  on alt+left-click, if `hasMouseTracking()` (i.e. tmux/app owns the mouse — the normal
  case) forward the clicked cell to the `tmuxAltClickMoveCursor` RPC **without swallowing
  the event**, so the SGR path still delivers the alt-click to mouse-owning apps. If
  tracking is off (bare PTY, no tmux) move locally via `buildCursorMoveSequence()` plain
  CSI arrows over the WS and swallow the click.
- **Backend** (`rpc-handlers/tmux-pty.ts` + pure logic in `src/bun/tmux-alt-click.ts`):
  hit-test the clicked cell against `list-panes` geometry (zoom-aware: only the active
  pane when `window_zoomed_flag`), require a live shell pane (`zsh/bash/fish/…` allowlist)
  not in copy-mode, require the click on the cursor's row, clamp the target column to the
  row text length (a click right of EOL lands at EOL — no zsh-autosuggestions accept),
  then `select-pane` (only when not active — select-pane un-zooms) + `send-keys Left/Right × N`.
- **SGR modifier fix:** `sgrMouse` call sites now add the Alt bit (8) so tmux forwards
  real M-clicks to apps that requested the mouse — Claude Code's built-in alt-click works
  through dev3 for the first time. Shift/Ctrl deliberately stay unencoded.
- Discoverability: one "Did you know?" tip (`alt-click-move-cursor`, score 4). No
  `keymap.ts` entry (mouse gesture). UX plan: `docs/ux/feature-plans/alt-click-move-cursor.md`.

## Risks
- Horizontal-only on the cursor's row; wrapped/multi-line buffers out of scope (ambiguous).
- Row-text clamp measures JS string length — wide glyphs (CJK/emoji) on the line skew the
  clamp by their extra columns; worst case is a few extra harmless arrows.
- Alt+drag no longer starts tmux's copy-mode drag selection (the Alt bit makes it
  `M-MouseDrag1Pane`, unbound) — alt is now the cursor-move modifier; plain drag unchanged.
- `pane_current_command` allowlist misses shells not listed (e.g. nushell) and REPLs with
  readline (python, psql) — conservative no-op there; extendable later.

## Alternatives considered
- **Renderer-only `hasMouseTracking()` gate (v1)** — does not work: tmux `mouse on` keeps
  outer tracking permanently enabled (verified). Kept only as the bare-PTY fallback path.
- **Pane-info cache in the renderer** to decide synchronously — stale-cache wrong decisions
  and an extra sync channel for zero gain; the RPC is not on a hot path.
- **tmux binding on `M-MouseDown1Pane`** — tmux has no "move readline cursor to cell"
  primitive, so the binding would still need an external helper; more moving parts.
- **Emitting vertical arrows** — wrong in a shell (Up/Down = history). Skipped.
