# 008 — Git operations in visible terminal panes

## Context

Git operations (push, rebase, merge) ran silently via `Bun.spawn` in `git.ts`, with errors shown through `alert()`. Users had no visibility into what was happening — errors were truncated, authentication prompts were invisible, and conflict details were lost.

## Investigation

The dev server already used a pattern of writing a bash script to `/tmp/` and running it in a `tmux split-window -h` pane within the task's tmux session (`runDevServer` in `rpc-handlers.ts`). This gave full visibility and worked well.

## Decision

Rewrote `pushTask`, `rebaseTask`, and `mergeTask` RPC handlers to follow the `runDevServer` pattern:

1. Handler creates a bash script in `/tmp/dev3-{taskId}-git-{op}.sh` with the git commands
2. Opens a horizontal tmux split pane via `tmux split-window -h` in the task's session
3. Returns `void` immediately (fire-and-forget)
4. A background polling monitor (`monitorGitPane`) checks if the pane still exists every 1s via `tmux display-message`
5. When the pane closes, reads the exit code from `{scriptPath}.exit` and sends a `gitOpCompleted` push message to the UI
6. UI listens for `gitOpCompleted` events to refresh branch status and trigger the post-merge completion dialog

Scripts use `set -x` for command visibility, colored ANSI success/failure messages, auto-close on success (after 2s), and wait for keypress on failure.

Key files:
- `src/bun/rpc-handlers.ts`: `killExistingGitPane()`, `openGitOpPane()`, `monitorGitPane()`, rewritten handlers
- `src/shared/types.ts`: RPC response types changed to `void`, added `gitOpCompleted` message
- `src/mainview/rpc.ts`: wired `gitOpCompleted` → CustomEvent
- `src/mainview/components/TaskInfoPanel.tsx`: simplified handlers + `useEffect` for completion events
- `src/bun/git.ts`: removed `rebaseOnBase()`, `mergeBranch()`, `pushBranch()`

## Risks

- **Rebase conflict handling changed**: Previously, failed rebases were auto-aborted. Now the user sees the conflict in the terminal and must manually `git rebase --abort` or resolve. This is intentionally better UX but changes behavior.
- **Pane monitoring relies on polling**: 1s interval is low overhead but not instant. If tmux dies entirely, the safety timeout (10 min) cleans up.
- **Exit file in /tmp**: Could accumulate stale files. Not a practical concern since filenames include task IDs.

## Alternatives considered

- **WebSocket streaming**: Stream git output via a separate WebSocket channel to a custom UI panel. Too complex, reinvents what tmux already provides.
- **Keep RPC + show output**: Run git command via Bun.spawn AND somehow mirror output to a terminal. Complex, fragile.
- **tmux wait-for**: Use `tmux wait-for` instead of polling to detect pane closure. Cleaner but hangs if the script crashes before signaling.
