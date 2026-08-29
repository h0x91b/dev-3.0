# `dev3 events` is addressed by a cursor, and the caller carries it

## Context

An agent coordinating the board can only learn what was *messaged* to it. Notes are per-task
(`dev3 note list` takes one task), so there was no way to ask "what did anybody record recently".
The cost is measured, not theoretical: on 2026-08-28 nineteen tasks finished within twenty-four
hours, and a finished task cannot message anyone — its notes are all that survived its worktree.
Nobody opens nineteen finished tasks by hand.

## Investigation

Two things had to be established before the shape could be chosen, and both were verified rather
than trusted.

**Notes really do survive teardown.** They are not a per-task store and not in the worktree: a note
is an entry in `Task.notes[]` inside `~/.dev3.0/data/<slug>/tasks.json`. Measured on the dev-3.0
board on 2026-08-29 — 1839 tasks, 8.7 MB, 717 tasks carrying 1799 notes, of which 711 tasks are
already completed or cancelled. Reading every task's notes is therefore one pass over an array the
app already holds; there is no per-task storage walk and no cost that scales with board size beyond
the load `tasks.list` already pays.

**`dev3 conversations search` does not cover this.** It indexes note bodies (`EngineTask.notes` in
`src/bun/conversation-search.ts`), but it is keyword search over terminal-status tasks with
relevance ranking — it cannot answer "everything, in time order, since a position", which is the
only question a periodic sweep asks.

## Decision

`dev3 events` (`src/cli/commands/events.ts`, handler `events.list` in `src/bun/cli-socket-server.ts`,
pure selection in `src/shared/board-events.ts`).

**A cursor, not a time window.** `--since 2h` fails in the dangerous direction: a coordinator sweeps
when the user asks, not on a schedule, so a relative window silently drops everything older than
itself and reports success. The caller cannot tell a quiet period from a truncated one. A cursor is
a position — one instant, printed as `2026-08-28T20:22:22.303` — so the same cursor against the same
board gives the same answer, every time. `--from` also takes a plain date and a duration (`2h`,
`3d`); both resolve to an instant before anything is read, and a duration is never what a quiet
sweep echoes back, or a stored cursor would be a moving window.

**The caller carries the cursor; the app remembers nothing per caller.** Server-side memory is
easier to use, but it has no honest answer to "who is asking". Identity would have to be derived
from the working directory, and outside a worktree there is none — so every such call would share
one global position and steal each other's, which is the same silent skip that killed `--since`. A
position that also advances on read loses events whenever a read is interrupted. Explicit `--from`
therefore always works, including the wider bare-ISO form.

**The bare call is a labelled window that counts what it cut.** With no `--from` the command reads
the last 24 hours, says in words that this is a window rather than a position, and prints the exact
number of events older than it (`olderThanWindow`). The count is free — the full corpus is already
in hand — and it is what turns "probably nothing" into "340 events, go and get a cursor".

**Milliseconds in the cursor are load-bearing; everything else was cut.** The printed form carries
no `Z` and no note id — it is copied by hand into an agent's prompt often enough that ten wasted
characters are a real cost. Millisecond precision stays because it was measured, not assumed: across
the 1805 notes on the dev-3.0 board, **73 individual seconds carry more than one note and no
millisecond carries two**. A second-precision cursor would therefore have to either re-show the last
event on every call or skip its same-second siblings, and roughly 8% of notes sit in such a group.
For the same reason the cap never splits a group sharing one instant — a cursor cannot address half
of one.

**The cap keeps the oldest.** `--limit` (default 100) drops the *newer* matches and reports how
many, so continuing from the printed cursor leaves no hole; dropping the oldest would skip them
forever. Both boundaries are stated as numbers: silent truncation reads as "that was everything".

An unparseable cursor exits `CLI_EXIT_CODE_EVENT_CURSOR_INVALID` (19) and reads nothing, rather than
degrading into a time window.

## Risks

- The caller can lose its cursor (an agent's context is wiped). Mitigated by the counted 24-hour
  window: the loss is visible and quantified, not silent.
- Two notes sharing a millisecond exactly would be indistinguishable to a cursor. None exist on the
  current board (0 of 1805), and the cap deliberately widens rather than splitting such a group, so
  the failure would be one repeated line rather than a skipped note.
- v1 emits only `kind: "note"`. Board movements and completions are the natural v2; the `KIND`
  column and the `--kind` filter exist so they arrive as a filter rather than a reformat.

## Alternatives considered

- **A duration as the DEFAULT addressing mode** — rejected: silently truncating and reporting
  success is the exact failure this command exists to prevent. A duration is still accepted as an
  explicit `--from` value, where the caller chose the window knowingly.
- **A second-precision or opaque compact cursor** — rejected on the measurement above: seconds
  collide 73 times on this board, and an opaque base36 form saves a handful of characters at the
  cost of a cursor a human can no longer read in a prompt.
- **Server-side per-caller cursors** — rejected: no honest caller identity outside a worktree, plus
  a read-advances position is lossy on interruption. It would also put new per-caller state under
  `~/.dev3.0`, which the on-disk invariants make expensive to get right for little gain.
- **Extending `dev3 conversations search`** — rejected: it is relevance-ranked keyword search, and a
  sweep has no keywords.
- **Returning every note to the CLI and selecting there** — rejected: the "older than the window"
  count needs the full corpus, and shipping 1799 note bodies over the socket to learn one number is
  the expensive way to learn it.
