# Project task state at the replay cursor instead of reading the live board

Data layer only. The surface that consumes this — cursor wiring, card treatment, captions —
is Seq 1835's, and its own record covers those choices.

## Context

Agent traffic replay walked the recorded message log but drew every task card in the state it is
in **now**. A task that completed an hour after the message being replayed was already green at
the start; a task created after it was already on stage. The surface admitted this in a caption,
which is honest and useless: the replay is supposed to show what the board looked like.

## Investigation

Board history exists, and it is nearly empty. `Task.movements[]` shipped in PR #1661
(`0d81efcff`), **merged 2026-09-05**. Measured on the live dev-3.0 board on 2026-09-08:

| | |
|---|---|
| Tasks total | 1924 |
| With any `movements[]` | 22 |
| With none | 1902 |
| Longest log | 50 — already at `MAX_TASK_MOVEMENTS_KEPT` |
| Already truncated (`movementsDropped`) | 1 |

**A merge date is not a collection start**, and neither establishes when recording actually began
on a given machine — that depends on when the running build was replaced. The measured onset here
is the earliest movement on disk: **2026-09-06T02:00:13Z**, a day after the merge, with 275
movement rows across 22 tasks. The archive establishes observed coverage and nothing more.

Nothing older can be recovered, and this was established rather than assumed: Seq 1675's note
`74ef8edd` shows `statusEnteredAt` dates only the last move, `statusDurations` proves a status was
visited without saying when or in what order, and `Task.history[]` carries title/overview only.
There is no backfill and none is possible.

Two facts shaped the design. Truncation is real from day one, so a missing `created` entry does
**not** mean "task predates capture" — hence three confidence values, not two. And the state
before the earliest recorded movement is that movement's own `from`, a recorded fact: a partially
known task still gets a correct status, just no birth moment.

No new read API was needed. `splitTaskBlobs` (`src/bun/task-blobs.ts`) claims only `history[]` and
`completedDiffStats.fileStats`, so `movements` stays in `tasks.json` and already arrives in the
renderer through the ordinary `getTasks` RPC.

## Decision

`projectTaskAt(task, at)` in `src/mainview/components/agent-traffic/task-history.ts` is a pure,
total function from a task plus a cursor instant to `{ present, status, columnId, confidence }`.

**An unrecorded past is unknown, not today's status.** The first version returned the live status
with a "History not recorded" marker beside it. That was wrong and was replaced: a green
*Completed* card reads as history whatever the small print says, so `status` is `TaskStatus | null`
and `null` means *not known*. A `partial` record still carries a real status, because the state
before the earliest record is that record's own `from` — recorded evidence, not a guess. Absent
that field the status is `null` too. The live status is never borrowed.

**`present: false` is only ever a fact.** Returned when the first recorded movement is `created`
and the cursor precedes it. A task with no movements is present with `confidence: "unrecorded"`,
because "we did not record it" is not "it did not exist". A ghost the message log remembers but
the board no longer holds gets the same treatment.

**Purity is the scrubbing mechanism.** There is no accumulated state to unwind, so seeking
backwards is a recomputation, not a rewind. A test asserts the forward and backward walks are
element-for-element equal.

**The cursor indexes a union, not messages.** `traffic-timeline.ts` holds `TrafficTimelineEvent` —
a `task` arm built from `Task.movements[]` and a `message` arm — sorted by time, then a literal
`TIMELINE_KIND_RANK`, then key. Indexing `TrafficRecord[]` meant a card could only change state
when a message happened to arrive nearby: an hour where the board moved and nobody spoke had zero
steps. `task: 0` in that rank is load-bearing rather than alphabetical — a message stamped at the
same millisecond as a `created` movement must land on a card that already exists, and the first
draft had `task` last, which renders a bubble against a card that has not appeared yet. It stays a
discriminated union with a literal rank so a further arm is additive: a member, a rank entry, and
nothing else in the file moves.

An unparseable movement instant is dropped, never coerced to 0 — a 1970 event would sort ahead of
every real one and read as the start of the window.

**One requirement handed to the consumer:** project at render time per card, never by filtering
the node set upstream. The layout is derived from that set, so filtering reflows the stage on every
tick. Seq 1835 owns how that is done.

## Risks

- **Almost invisible on a real board today.** With 22 of 1924 tasks carrying movements, most cards
  resolve to "unrecorded" for a while. That is the honest answer, not a bug, and it improves by
  itself as capture accumulates.
- **`MAX_TASK_MOVEMENTS_KEPT = 50` truncates a busy task's birth**, so it projects as present for
  the whole window with `confidence: "partial"`. Raising the cap is a data-layer decision with a
  whole-board serialisation cost and was deliberately not touched.
- **Hibernation, project moves and variant appearance are not recorded at all**, so those
  dimensions cannot be projected and stay current. The consumer must disclose that.
- **These two modules ship with no caller.** Until Seq 1835 wires them, they are unreferenced in
  `main`; they are pure and import only `shared/types` and `traffic-model`, so nothing changes at
  runtime.

## Alternatives considered

- **Record a full board snapshot per movement.** Would answer any question about the past exactly.
  Rejected: it multiplies `tasks.json` (already 10 MB) by the movement count and touches the shared
  on-disk contract for a read-side feature.
- **Derive the past from `statusEnteredAt` / `statusDurations`.** Rejected on evidence, not taste —
  see Investigation and Seq 1675's note.
- **Keep the live status with a disclaimer for an unrecorded past.** The shipped first version.
  Rejected on a product ruling and on the merits: the disclaimer is small print next to a status
  colour, and a reader takes the colour.
- **Keep the cursor an index into messages and let task states change on the nearest message.**
  Cheaper, and it looks right on a busy hour. Rejected: it silently misdates every transition and
  produces nothing at all for an interval with no messages.
