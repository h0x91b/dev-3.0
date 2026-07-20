# 141 — Terminal ⌘F search runs in tmux copy-mode, not in ghostty's buffer

## Context

⌘F should search the focused terminal's scrollback. dev3 runs tmux with `mouse on`, so wheel scroll is forwarded as SGR mouse events and the history lives **inside tmux** — ghostty's own buffer only ever holds the visible screen. A renderer-side buffer search (xterm.js-search-addon style) would therefore see one screenful and nothing else; ghostty-web also ships no search addon.

## Investigation (live, tmux 3.6a on a scratch socket)

- `send-keys -X search-backward-incremental` does nothing when driven externally (count=0, cursor frozen) — it only works from tmux's own `command-prompt -i`.
- Plain `search-backward` searches up from the CURRENT cursor, so retyping a growing query walks the cursor further up each keystroke, skipping matches nearer the bottom ("n"→"ne"→"need" drifted 28 lines up).
- Fix: `send-keys -X history-bottom` before every query re-anchors the search at the newest output; `search-backward-text` (literal, not regex) then finds the match nearest the bottom. Verified drift-free.
- `#{search_count}` is STALE after a miss — `#{search_present}` gates it (`matches = present ? count : 0`).
- First `search-reverse` after `search-again` re-finds the current match (native tmux n/N quirk) — accepted, not worked around.

## Decision

Search runs entirely in tmux copy-mode: `TerminalSearchBar.tsx` (floating bar over `TerminalView`, opened by ⌘F/Ctrl+F when focus is inside the terminal) drives three RPCs in `rpc-handlers/tmux-pty.ts` — `tmuxSearchUpdate` (enter copy-mode → history-bottom → search-backward-text → read `SEARCH_STATE_FORMAT`), `tmuxSearchStep` (search-again/search-reverse), `tmuxSearchCancel` (exit copy-mode). tmux natively highlights all matches and scrolls the pane; the picture streams back through the PTY with zero renderer work. The first update resolves and pins the session's active pane id so the search survives tmux focus changes.

## Scope — one pane, made visible

tmux copy-mode is a per-pane mode, so search covers exactly the focused pane's scrollback — content in a sibling split or another window is not searched (native tmux `/`/`?` behave identically). Rather than fake a cross-pane search (would mean juggling copy-mode across panes or a self-drawn `capture-pane` result list — rejected as heavy duplication), we make the scope obvious: when the terminal is split (≥2 panes in the on-screen window) the searched pane gets an accent frame (`TerminalView` overlay via `utils/paneHighlight.ts`, the same cells→% mapping as `ClosePanePicker`, gated on the active window). The user clicks another pane and presses ⌘F to search it. Single-pane terminals get no frame (no ambiguity). The frame reuses the existing `tmuxLayout` RPC — no backend change.

## Risks

- While in copy-mode the pane is frozen (standard tmux); closing the bar cancels copy-mode and resumes live output.
- The frame goes stale if the user drags a split divider mid-search (layout is fetched on pane-resolve, not per keystroke); it's a hint only and search is unaffected. Split changes mid-search are rare.
- Alt-screen TUIs (vim, Claude Code) have no scrollback — search covers the visible screen only, matching native tmux behavior.
- macOS binds only ⌘F; Ctrl+F stays readline forward-char. Linux binds Ctrl+F (VS Code terminal convention), shadowing forward-char there.

## Alternatives considered

- ghostty buffer search — sees one screenful (history is in tmux); rejected.
- `capture-pane -S -` + renderer-side match list — full custom highlight/scroll UI for data tmux already renders; rejected as heavy duplication.
- `search-backward-incremental` — inert outside `command-prompt -i` (verified); rejected.
