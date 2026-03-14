# 015 — AI Review Uses tmux Split-Pane (Not New Window)

## Context

The AI Review stage spawns a second agent in the same tmux session as the primary agent. We needed to decide how to present this to the user.

## Investigation

Tried three approaches:
1. **`tmux new-window`** — steals focus to a separate window. User thinks the primary session "died" because they suddenly see a different pane. Confusing UX.
2. **Separate PTY session** — PTY server is keyed 1:1 by taskId. Would require deep refactoring.
3. **`tmux split-window -h -l 30%`** — creates a vertical split in the same window. Both agents visible side-by-side.

## Decision

Used `split-window -h -l 30%` to create a right-side pane (`launchColumnAgent()` in `src/bun/rpc-handlers.ts`, formerly `launchReviewAgent`). The pane ID is saved to `/tmp/dev3-{taskId}-col-agent-pane` for cleanup on re-runs. After creating the split, focus returns to the main pane via `select-pane -t :0`.

> **Update (decision 017):** `launchReviewAgent` was generalized into `launchColumnAgent` to support any column (not just AI Review). The mechanics are identical; the function now accepts a `ColumnAgentConfig` and an optional `onExitCommand`.

Pane title (`printf '\033]2;...\033\\'` in the wrapper script) is set but not reliable — Claude Code overwrites pane titles. The saved pane_id file is the authoritative reference.

## Risks

- If the user manually closes/rearranges panes, the saved pane ID may be stale. `kill-pane` on a non-existent pane is silently ignored.
- The 30% width may be too narrow for some terminal sizes. Not configurable yet.
- **Stop hook parallel execution assumption:** The two Stop hook groups in `.claude/settings.local.json` rely on Claude Code launching both hook subprocesses *concurrently* (not sequentially). Both processes read the task status before either has written a new value, so their `--if-status` / `--if-status-not` guards are mutually exclusive by race. If Claude Code ever switches to sequential hook execution, the primary-agent Stop would transition to `review-by-ai` and then immediately to `review-by-user`, skipping AI review entirely. This has been manually verified to work with the current Claude Code version but is not covered by automated tests.

## Alternatives Considered

- Named tmux windows (`-n review`) — rejected because `new-window` steals focus and is disorienting.
- Pane identification by title — rejected because Claude Code overwrites `\033]2;` sequences.
