# Project task state at the replay cursor instead of reading the live board

## Context

Agent traffic replay (Experiment 2) walked the recorded message log but drew every
task card in the state it is in **now**. A task that completed an hour after the
message being replayed was already green at the start; a task created after it was
already on stage. The surface admitted this in a caption — "Task states are current;
the timeline filters messages only" — which is honest and useless: the replay is
supposed to show what the board looked like.

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

**A merge date is not a collection start**, and neither establishes when recording actually
began on any given machine — that depends on when the running build was replaced. The measured
onset here is the earliest movement on disk: **2026-09-06T02:00:13Z**, a day after the merge,
with 275 movement rows across 22 tasks by the time of measurement. The archive establishes
observed coverage and nothing more.

Nothing older can be recovered, and this was already established rather than assumed:
Seq 1675's note `74ef8edd` shows `statusEnteredAt` dates only the last move,
`statusDurations` proves a status was visited without saying when or in what order, and
`Task.history[]` carries title/overview only. There is no backfill and none is possible.

Two facts followed that shaped the design. First, truncation is real from day one, so a
missing `created` entry does **not** mean "task predates capture" — hence three
confidence values, not two. Second, the state before the earliest recorded movement is
that movement's own `from`, which is a recorded fact: a partially-known task still gets
a correct status, just no birth moment.

No new read API was needed. `splitTaskBlobs` (`src/bun/task-blobs.ts`) claims only
`history[]` and `completedDiffStats.fileStats`, so `movements` stays in `tasks.json` and
already arrives in the renderer through the ordinary `getTasks` RPC.

## Decision

`projectTaskAt(task, at)` in `src/mainview/components/agent-traffic/task-history.ts` is
a pure, total function from a task plus a cursor to `{ present, status, columnId,
confidence }`. `useTrafficPlayback` exposes one derived `cursor: ReplayCursor` so no
consumer re-parses a timestamp or invents its own meaning for "live".

**An unrecorded past renders as unknown, not as today's status.** The first version returned
the live status with a "History not recorded" marker beside it. That was wrong and was
replaced: a green *Completed* card reads as history whatever the small print says, so
`status` is now `TaskStatus | null` and `null` paints the card in the neutral tertiary ink
with the line *"Status not recorded"*. A `partial` record still carries a real status, because
the state before the earliest record is that record's own `from` — recorded evidence, not a
guess. Absent that field the status is `null` too; the live status is never borrowed.

**The cursor indexes a union, not messages.** `traffic-timeline.ts` holds
`TrafficTimelineEvent` — a `task` arm built from `Task.movements[]`, a `message` arm, and a
`notification` arm Seq 1825 fills — sorted by time, then a literal `TIMELINE_KIND_RANK`, then
key. Indexing `TrafficRecord[]` meant a card could only change state when a message happened
to arrive nearby: an hour where the board moved and nobody spoke had zero steps. `task: 0`
in that rank is load-bearing rather than alphabetical — a message or a bubble stamped at the
same millisecond as a `created` movement must land on a card that already exists, and the
first draft of the contract had `task` last, which renders a bubble against a card that has
not appeared yet. `seekToTime(at)` lands on the first event at or after a time and returns
whether it found one, so an entry range can distinguish an empty window from the top.

Three deliberate choices inside the projection:

1. **Purity is the scrubbing mechanism.** There is no accumulated state to unwind, so
   seeking backwards is a recomputation, not a rewind. A test asserts the forward and
   backward walks are element-for-element equal.
2. **`present: false` is only ever a fact.** It is returned when the first recorded
   movement is `created` and the cursor precedes it. A task with no movements is present
   with `confidence: "unrecorded"`, because "we did not record it" is not "it did not
   exist". A ghost the message log remembers but the board no longer holds gets the same
   treatment.
3. **The projection is applied at Card render time in `TrafficNodes`, not folded into
   the `nodes` prop upstream.** `layoutTraffic` keeps receiving the full node set, so an
   unborn card sits at its final position with `opacity: 0` and appears in place.
   Filtering nodes instead would have re-run the layout on every playback tick and
   shifted the stage under the user, undoing the Seq 1808 / 1820 camera work.

The completed treatment is a filled stamp — icon plus the status word plus a tinted
fill and a full-bleed 4px status rule — so the verdict does not depend on colour alone
(`better-ui`: motion and colour are never the only feedback channel). Both card
selectors carry a `:not()`, so the `prefers-reduced-motion` block had to name them
explicitly or it would have lost on specificity.

The "states are current" captions were replaced rather than kept. The summary line claims a
rebuild only when `experiment === "2" && cursor.at !== null` — Experiment 1 has no cursor and
Experiment 2 on Live is showing the board as it is, so claiming a rebuild there would be the
same falsehood inverted. `traffic.replay.currentStates` says overviews and titles are current
while statuses are rebuilt *during replay*.

## Risks

- **The feature is almost invisible on a real board today.** With 22 of 1924 tasks
  carrying movements, most cards will show "History not recorded" for a while. That is
  the honest render, not a bug, and it improves by itself as capture accumulates.
- **`MAX_TASK_MOVEMENTS_KEPT = 50` truncates a busy task's birth**, so its card is drawn
  as present for the whole window and labelled `partial`. Raising the cap is a data-layer
  decision with a whole-board serialisation cost and was deliberately not touched here.
- **Hibernation, project moves and variant appearance are not recorded**, so a replayed
  card's parked state and its project are always the current ones. Disclosed once on the
  stage (`traffic.nodes.currentOnlyDimensions`, shown only while a cursor stands in the
  past) rather than as a per-card badge the log has nothing per-card to justify.
- Only the `nodes` stage reconstructs. Experiment 1 (orbit) has no cursor and keeps
  current states, which its caption still states.

## Alternatives considered

- **Filter unborn nodes out of the `nodes` prop.** Simplest to write, and it makes cards
  appear for free. Rejected: the layout is derived from the node set, so the stage would
  reflow on every tick.
- **Record a full board snapshot per movement.** Would answer any question about the past
  exactly. Rejected: it multiplies `tasks.json` (already 10 MB) by the movement count and
  touches the shared on-disk contract for a read-side feature.
- **Derive the past from `statusEnteredAt` / `statusDurations`.** Rejected on evidence,
  not on taste — see Investigation and Seq 1675's note.
- **Leave the caption and do nothing.** Rejected: the replay's whole claim is that it
  shows the past, and a caption apologising for showing the present is a feature that
  does not work.
- **Keep the live status with a disclaimer for an unrecorded past.** The shipped first
  version. Rejected on a product ruling and on the merits: the disclaimer is small print
  next to a status colour, and a reader takes the colour.
- **Keep the cursor an index into messages and let task states change on the nearest
  message.** Cheaper, and it looks right on a busy hour. Rejected: it silently misdates every
  transition and produces nothing at all for an interval with no messages.
