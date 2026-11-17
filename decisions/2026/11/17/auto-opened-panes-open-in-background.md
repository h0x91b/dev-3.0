# Auto-opened panes open in the background; only explicit user actions take focus

## Context
`decisions/2026/10/03/new-tmux-windows-open-in-background.md` stopped windows from taking the screen, but a split still made the new pane active. A column agent, an Operations shell, a resumed pane, `dev3 pane run`, `dev3 agent spawn` or `dev3 dev-server start` therefore pulled keyboard focus off the agent pane while the user was typing in it. User-approved on 2026-11-17: the window rule extends to splits.

## Investigation
Verified on a throwaway tmux 3.6a server: a server `command-alias` `split-window=split-window -d` applies to a raw `tmux split-window` run inside a pane, to client commands and to key bindings (`list-keys` shows `split-window -dh`). `select-pane -t <pane> -T <title>` only sets the title and never changes the active pane. Code that re-selected `${session}:.0` to "return focus" never worked: `pane-base-index` is 1, so pane `.0` does not exist and the call failed silently.

## Decision
`tmux.splitWindow` always passes `-d`; `focus: true` prints the new pane id and runs `select-pane -t <id>` (same shape as `newWindow`). `src/bun/tmux/config.ts` adds `command-alias[92]/[93]` for `split-window`/`splitw`, and the user's `⌃B |`, `⌃B \`, `⌃B -` bindings and the stock `⌃B "` and `⌃B %` splits (rebound, since otherwise the alias would silently background them) carry an explicit `-d` (aliases are expanded at `bind` time, before the alias lines run on a fresh server) and append `select-pane -R` / `-D` so they still land on the new pane. Focus is requested only for explicit UI actions: tmuxAction split, "+ Agent" (`spawnAgentInTask` `focus`), dev-server start/restart from the UI (`runDevServer`/`restartDevServer` `focus`), the script runner split, bug hunters and the file browser. Git operation panes (push/rebase/merge), setup re-run, `dev3 agent spawn`, `dev3 dev-server start`, `dev3 pane run`, the column/review agent, the Operations shell, resumed panes and the setup startup wrapper (explicit `-d` and `select-pane -U` on its `-b` split) leave the agent pane active. The broken `.0` re-selects are removed.

## Risks
The aliases are server-wide on the shared `dev3` socket, so an older app version on the same server loses focus on its own UI splits, and its startup wrapper (no `select-pane -U`) leaves focus on the setup pane. A raw `tmux split-window` typed by anyone in a dev3 session no longer switches panes unless it adds `select-pane`.

## Alternatives considered
An `after-split-window` hook that switches back (flicker, more moving parts); passing `-d` only from app code (agents running raw `tmux split-window` are the main source of the jump and stay untouched); re-selecting the agent pane after each split (racy, and the `.0` target proved unreliable). To revert: delete the two aliases, drop the `select-pane` suffixes from the bindings and the `-d` in `splitWindow`.
