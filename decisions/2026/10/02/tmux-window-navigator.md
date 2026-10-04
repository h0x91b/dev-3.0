# In-app navigator for a task's tmux windows

## Context
A new tmux window (⌘T, the New window button, a script, an agent's `tmux new-window`) becomes the active one at once, and on desktop the only trace of the others was the tmux status line. Users read that as "my task disappeared". Narrow viewports already had `MobileWindowCarousel`; desktop had nothing.

## Investigation
Verified on a throwaway tmux 3.6a server: a fresh pane's `pane_title` is the hostname while `window_name` is the command; `window_id` is stable while indexes renumber; `window_activity` / `window_bell_flag` and the `@dev3_agent` pane option are readable through ordinary formats. Claude's pane title carries a flickering status glyph prefix.

## Decision
`TerminalWindowNav.tsx` wraps the desktop tmux terminal and renders always, even with one window (the user reversed auto-hide on 2026-10-04, so the place never moves; a lone window gets no × or menu): vertical tabs in a 28px left rail (default: names written sideways, costs width not a terminal row; numbered tiles were replaced because they hid names and the close control) or top tabs, chosen in Appearance (`terminal-window-nav.ts`, localStorage, like zoom). The terminal child keeps one tree position in every state so the navigator never remounts it. `tmuxWindowNavigate` now returns `TmuxWindowEntry[]` and navigates by `windowId`; `src/bun/tmux/window-nav.ts` owns the label rule (real title → window name → "Window N") and the home rule (window of the last-focused agent pane, else the first agent pane). The home window is named after the task title in the renderer, matching the tmux bar from the parallel status-bar work. "New output" is renderer-side (`useTmuxWindows`: activity past what you last saw) and never applies to the home window, which repaints constantly. Updates are a 3 s poll of the visible terminal plus an immediate refresh after the app's own new-window calls (`openTmuxWindow`).

## Risks
Up to 3 s lag for windows created outside the app. A restarted agent pane without `@dev3_agent` loses its ✦.

The navigator replaces the tmux window bar in task sessions: the app turns a task session's own `status` off on every attach (`hideTmuxWindowBar`, `src/bun/pty-server.ts`), right after `configureTmux` clears stale overrides; since #1912 no hook re-evaluates the bar, so that `off` holds. Project terminals and external sessions keep the bar.

## Alternatives considered
Breadcrumb `task › window › pane` (hides the other windows), a window-count chip in the task panel (gone when the panel is collapsed), an overlay pill or an overview grid only (background state invisible). Opening agent-created windows in the background is its own decision: `decisions/2026/10/03/new-tmux-windows-open-in-background.md`.
