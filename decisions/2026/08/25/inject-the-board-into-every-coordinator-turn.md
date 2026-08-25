# Inject the board into every coordinator turn

## Context

`COORDINATOR_PROMPT` used to admit the problem outright: "YOUR PICTURE OF THE
BOARD IS A SNAPSHOT, not a feed… re-read the board before every status." That is
a discipline rule, enforced by the model remembering it, and it costs a tool call
every time it works.

The gap that actually burned the user: he walks the child tasks, changes things
there, comes back to the coordinator and asks a question — and the coordinator
answers from a picture taken before that walk. Nothing on the board tells it
anything changed.

## Investigation

Three candidate seams:

1. **`release()` in `agent-message-hold.ts`** — the moment a coalesced burst is
   typed into a pane. Portable across harnesses, but covers only agent→agent
   traffic: the user's own keystrokes go straight to the pty and never pass
   through the hold. It also puts the block in the pane, where the human reads it.
2. **`UserPromptSubmit` hook** — dev3 already installs one for Claude and Codex
   (`buildClaudeHooks`, `buildCodexHooks`), per-worktree, refreshed before every
   delivery. It fires for the user's own Enter *and* for a delivered
   `dev3 message`, because that message is text plus an Enter and reaches the
   harness as an ordinary prompt. So it is a strict superset of (1), and its
   output goes to the agent's context rather than the pane.
3. **A timer pushing the board into the pane** — rejected. Text plus Enter wakes
   an agent up; a board arriving on its own would make the coordinator chatter
   and burn tokens on "nothing changed".

Confirmed live that Claude Code folds a `UserPromptSubmit` hook's stdout into the
turn: the existing `dev3 task move` hook's own output ("Moved task … → Agent is
Working") already shows up in the agent's context every turn.

## Decision

Option (2), and only that — (1) became redundant once (2) was shown to cover both
families of turn, so `agent-message-hold.ts` is untouched.

- `shared/coordinator-board.ts` — the contract and the pure renderer.
- `bun/coordinator-board.ts` — `collectCoordinatorBoard`: live tasks (not To Do,
  not finished) sorted by `compareTaskSortRank`, plus everything finished inside
  a rolling 24 hours. Activity costs one `tmux list-panes -a` per socket
  (`ALL_PANE_ACTIVITY_FORMAT`) for the whole board, not a peek per task.
- `board.snapshot` on the CLI socket answers `""` for anything that is not a
  coordinator, so the hook installs unconditionally and `--type coordinator`
  takes effect mid-session with no hook rewrite.
- `dev3 hook board` prints it, and is silent and successful on every failure.
- `COORDINATOR_PROMPT` now points at the block, keeps `dev3 peek` as the only way
  to see what a child is *doing*, and keeps a fallback for a harness with no
  injection.

Two rules the code enforces: board state is a **passenger** of a turn and never
its driver, and the block reports what the board **is**, never what changed —
marking changed rows would need the previous snapshot kept somewhere, and the
finished-in-24h section covers the one delta that matters.

## Risks

- **The block is taken when the turn begins**, so a ten-minute turn ends on a
  stale board. Mitigated by the timestamp in the tag and an explicit "re-read if
  this turn has run long"; not eliminated.
- **Codex gets nothing.** Its hook must answer with Stop-hook JSON (`{}`) on
  stdout, so free text cannot ride the same channel. Gemini, Cursor and Oh My
  OpenCode are likewise uncovered; the prompt tells a coordinator that sees no
  block to fall back to `dev3 task list`.
- **Native-backend tasks report `activity unknown`.** Peek only learns a native
  pane's time by capturing it, which is far too expensive per task per turn.
  Deliberately not smoothed into "quiet".
- **One extra CLI round-trip per turn per task**, bounded at 3 s and silent on
  failure. Measured payload on a 1762-task board: 7 live + 3 finished rows,
  ~1.4 KB.

## Alternatives considered

- **Delta instead of a full list** — a delta is useless after a context
  compaction, when there is no earlier snapshot to compare against.
- **Marking changed rows with `*`** — needs the previous snapshot held somewhere;
  the user explicitly did not want that state, and the finished-24h section buys
  the same thing.
- **Calendar-day window for finished tasks** — resets at midnight, so a morning
  coordinator loses the previous evening. A rolling 24 hours does not.
- **Cross-project boards** — every extra board is bytes in every turn of every
  coordinator. Scoped to the caller's own project.
