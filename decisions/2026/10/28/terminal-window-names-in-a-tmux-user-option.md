# Terminal window names live in a tmux window user option

## Context
Users asked to rename the tabs above a task's terminal. A tab's automatic label is the active pane's title (what Claude Code, vim or a shell set via OSC), else `window_name`, and the agent's home window shows the task title. All of these change on their own.

## Investigation
`rename-window` only sets `window_name` (and turns `automatic-rename` off), but both the tab bar (`windowLabel` in `src/bun/tmux/window-nav.ts`) and the status line (`WINDOW_LABEL` in `src/bun/tmux/themes.ts`) prefer the pane title over it, so a running agent would overwrite the rename on its next title update. tmux expands a user option once, without re-expanding `#{…}` inside its value, but the status line still parses `#[style]` out of the expanded text.

## Decision
The user's name is the window-scoped user option `@dev3_window_name` (`TMUX_WINDOW_NAME_OPTION`), written by the `tmuxRenameWindow` RPC (`src/bun/rpc-handlers/task-panes.ts`) through `TmuxClient.setWindowOption`/`unsetWindowOption`. Both labels read it first; the status line escapes it with `#{q/h:…}` so a `#` prints instead of styling the bar. An empty name unsets it and automatic naming returns. Input is normalized by `normalizeWindowName` (`src/shared/window-name.ts`): control characters flattened, 64 code points max — a TAB would otherwise split the TAB-separated format row.

## Risks
The name lives as long as the tmux window: it survives app restarts and reconnects (the tmux server outlives the app), but not the window being closed or the tmux server dying, which ends the window anyway. Nothing is written under `~/.dev3.0/`. Native-backend tasks have no windows and no tab bar, so the RPC is a no-op there; tmux's own `⌃B ,` still edits `window_name`, which the pane title keeps outranking, as before.

## Alternatives considered
`rename-window` plus disabling pane titles for that window — would fight every agent CLI's title updates and change what the status bar means. Persisting names in `tasks.json` keyed by window id — window ids are per tmux server and recycled, so a stored name could land on the wrong window after a server restart.
