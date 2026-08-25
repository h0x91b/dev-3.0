# The coordinator board reports column age, not terminal silence

## Context

The `<dev3-board>` block shipped with a right-hand column reading `quiet 41m ago*`, sourced from
tmux's `#{window_activity}` (`ALL_PANE_ACTIVITY_FORMAT`, one `list-panes -a` per socket). The
intent was "this child has produced nothing for 41 minutes — it is stuck or waiting". On the first
production board every row instead said `quiet 0s ago` or `quiet 1s ago`.

## Investigation

Measured on the live tmux server (3.6a) plus a scratch server as control:

- `window_activity` really is "last output in the window". A pane running `sleep 600` holds its
  stamp; `capture-pane`, `resize-window`, `refresh-client` and a global `set-option` do not move it.
- An interactive shell is different: resizing a window whose pane holds an idle `zsh` DOES move it,
  because the shell repaints its prompt on `SIGWINCH`. The `sleep` pane under the same resize did
  not move — that is the differential.
- An untouched idle `zsh` on its own server held one stamp for 4.5 minutes, so shells do not
  self-bump on a timer.
- On the live server, 45–49 of 60 panes carry ONE identical timestamp that jumps for all of them at
  once, irregularly, every few minutes. Across such a jump a pane's captured content is byte-identical
  (same md5 over 12 samples), so the "output" is an invisible repaint.

So some app-wide event repaints every pane, and every task inherits a timestamp that says nothing
about its agent. The exact trigger inside dev3 was not pinned; the likely candidate is the
redraw jiggle in `pty-server.ts` (`applyClientSizes`), which resizes by one row and back.

## Decision

The column now reports how long the task has been in its current column:
`statusEnteredAt ?? movedAt ?? createdAt`, rendered as `here 41m` (`src/bun/coordinator-board.ts`,
`activityCell` in `src/shared/coordinator-board.ts`). It is a different question than the original
one, and it is one the data can actually answer — a task sitting in Your Review for two days is
exactly what a coordinator needs to notice. The tmux read, `ALL_PANE_ACTIVITY_FORMAT`, and the
window-granularity footnote are deleted; the board no longer talks to tmux at all.

Same change fixes a display bug the screenshot also showed: a completed-and-hibernated task rendered
as `hibernated` and hid when it finished. `finishedAt` now wins over `hibernated`.

## Risks

- Column age can look calm while an agent is dead: a task can sit in Agent is Working for an hour
  having crashed in the first minute. `COORDINATOR_PROMPT` names this and points at `dev3 peek`.
- `dev3 peek` (`src/bun/task-peek.ts:158`) still reports `lastOutputAt` from the same polluted
  `window_activity`, so its per-pane freshness is wrong in the same way. Out of scope here and left
  as-is deliberately, not overlooked.

## Alternatives considered

- **Filter the herd**: drop any timestamp shared by most panes. Cheap, but a heuristic guarding a
  number we cannot otherwise trust.
- **Harness transcript mtime** (the `.jsonl` conversation file, as `conversation-search.ts` already
  does): the honest "when did this agent last produce a turn", but harness-specific and a bigger
  change than the board deserved on its own.
- **Drop the column**: honest and cheapest, but throws away the one at-a-glance signal on the board.
