# Board movements are recorded as they happen, because nothing on disk retained them

## Context

`dev3 events` shipped on 2026-08-29 carrying notes only (`decisions/2026/08/29/board-events-cursor-not-window.md`),
with a `KIND` column and a `--kind` filter reserved so movements could arrive as a filter rather than a
reformat. This is that second kind.

A note is a stored object the feed can simply read. A movement is an event: it happened and was over. So the
first question was whether the board already retains enough to reconstruct movements after the fact.

## Investigation

It does not, and this was measured on the live dev-3.0 board (1903 tasks) on 2026-09-05 rather than assumed.

| Field | Holds | Gives a past move? |
|---|---|---|
| `Task.status` | the column it is in now | no |
| `Task.statusEnteredAt` | instant it entered the CURRENT status, reset on each change | only the last one |
| `Task.movedAt` | instant of the last rendered-column change | only the last one |
| `Task.statusDurations` | cumulative ms per status | says a status was visited, never when or in what order |
| `Task.history[]` | title/overview snapshots; `changed` is `created \| title \| overview \| both` | no — status is not in the record |

**733 of 1903 tasks** have non-zero durations in more than one status — they demonstrably moved at least
twice — and each keeps exactly one `statusEnteredAt`. Worked example, seq 715: three visited statuses
(`review-by-user`, `review-by-colleague`, `in-progress`), one timestamp. Order and instants are unrecoverable.

Application logs do print `Updating task {updates}`, but they rotate and are not part of the on-disk data
contract; a feed built on them would lose history silently. `dev3 conversations search` indexes note bodies
only. The single salvageable fact is `movedAt` on a terminal task — when it finished — which is a
"recently finished" list, not a movement feed.

## Decision

Record movements at the moment they happen, in `Task.movements[]` inside `tasks.json`
(`src/shared/types.ts`, written by `applyTaskUpdate` and `addTask` in `src/bun/data.ts`, read by
`events.list` in `src/bun/cli-socket-server.ts`, rendered by `formatMovementText` in
`src/shared/board-events.ts`).

**One write site.** `applyTaskUpdate` is the choke point every status and custom-column change already passes
through, inside the cross-process `withFileLock` on `tasks.json`, and it already computes
`renderedColumnChanged`. One append there plus one seeded entry in `addTask` covers every move the board can
make.

**In `tasks.json`, not in the task blob.** `history` was offloaded to `task-blobs/<taskId>.json`
(`decisions/2026/08/16/...`), and the obvious symmetry would put movements there too. Rejected: `events.list`
reads every task's moves on every call, so a sidecar turns one file read into ~1900. Movements are small and
capped; `history` is neither. `splitTaskBlobs` leaves the field alone, and a test asserts that.

**The on-disk invariants are met literally.** No new file, no rename, no migration, no backfill. An older
version parses `tasks.json` into objects and re-serialises them, so an unknown key round-trips untouched —
the same mechanism by which `notes`, `priority` and `relations` were added. `data-movements.test.ts` proves
it by writing the file back the way an older build would and reading the movements out again afterwards.

**Which moves count.** Included: `created`, a status change, and a custom-column move at unchanged status.
Completion and cancellation are NOT separate kinds — they are the destination of an ordinary move
(`to: "completed"`), so nothing double-fires. Excluded deliberately: hibernate/un-hibernate (runtime state,
the card does not move), a variant appearing (that is a task creation, already covered), and
title/overview/priority/label edits (not movements, and overview churn is high-frequency agent bookkeeping
that would drown the feed).

**Both losses are stated as numbers rather than hidden**, because a feed that looks complete and is not is
the exact failure the cursor design exists to prevent:

- *The pre-feature gap.* Nothing older than this version exists. The help text says so; no history is
  invented, and no run pretends the board was quiet before the upgrade.
- *Retention.* A task keeps its 50 most recent movements (`MAX_TASK_MOVEMENTS_KEPT`), and
  `Task.movementsDropped` counts what the cap destroyed. `events.list` reports the drops belonging to tasks
  whose oldest surviving move is newer than the caller's position — i.e. only those that fell inside the
  answered range — and the CLI prints "this range is NOT complete".

**A filtered cursor is disclosed as filtered.** `--kind move` advances the cursor over movements only, so
reusing it unfiltered would skip the notes in the same span. Every filtered run says this in its footer.

## Risks

- `tasks.json` grows by roughly 55 bytes per move. Bounded per task, no backfill; on the current board that is
  well under 10% of a 9.4 MB file at the cap, and the cap is reached only by a task that ping-pongs 50 times.
- A deleted task takes its movements with it, exactly as it takes its notes.
- The gap before this version is permanent. It is disclosed, not repaired.

## Alternatives considered

- **Reconstruct from `statusDurations` + `statusEnteredAt`** — rejected on the measurement above: order and
  instants are simply not there.
- **A project-level append-only `board-events.jsonl`** — attractive for a chronological feed (one read,
  already sorted), rejected because it adds a second write path with its own append-tearing and locking
  problems for a file the existing `tasks.json` lock does not cover, to store data that must be joined back
  to the task anyway.
- **Per-task blob file** — rejected on read cost, above.
- **Extending `TaskHistoryEntry.changed` with a status value** — rejected: that record is a title/overview
  snapshot archived into the sidecar, and an older reader would meet a `changed` value its type does not have.
- **A separate `completed` kind** — rejected: it is a move whose destination is `completed`, and a second kind
  for it would fire twice for one event.
