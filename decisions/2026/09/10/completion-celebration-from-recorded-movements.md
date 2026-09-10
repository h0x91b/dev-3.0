# Celebrate completions from the movement log, and only claim the clock it proves

## Context

Agent traffic (Experiment 2, `TrafficNodes`) already replays the board from
`Task.movements[]`. A task reaching `completed` is the one moment on that stage
worth marking, and the obvious cheap sources for it — a UI button click, the
approval dialog, terminal output — each see only one of the two completion
paths and none of them exists during replay.

## Investigation

`src/bun/data.ts:1291` funnels **every** rendered-column change through a single
`recordTaskMovement` writer, so a manual `dev3 task move --status completed` and
an agent-approved completion produce the identical `TaskMovement`. That makes
the movement log the only source that covers both paths and is equally readable
live and at a replay cursor.

For the duration, `Task.lifecycleStartedAt` looked ideal — it is documented as
the current delivery cycle's first `in-progress` move. It is live state that a
reopen resets, so replaying an *older* completion would print a later cycle's
clock against it. The movement log carries the same fact historically.

## Decision

`src/mainview/components/agent-traffic/completion-celebration.ts` holds the pure
half: detection (`liveCompletions`, `replayCompletion`), the duration
(`completionDuration`) and a deterministic burst shape (`burstPieces`).
`TrafficNodes.tsx` owns the timers, the single celebration slot and the camera.

Three rules the module exists to enforce:

- **Duration is labelled by what it measures.** A preceding `in-progress` move →
  "completed in X" (`worked`). No work start but the task's own `created` entry →
  "X old" (`age`), a deliberately different sentence. Neither → **no number**.
  Nothing here is ever presented as agent work or CPU time; nothing on disk
  records that.
- **One movement, one celebration.** The live scan seeds its seen-set on the
  first pass, so opening the screen on a board full of finished tasks — and any
  remount — is silent. It keeps seeding while replaying or paused, or returning
  to live would fire everything that happened meanwhile.
- **Replay celebrates a forward crossing, not a resting place.** Scrubbing
  backwards is silent and standing still does not re-fire; re-crossing forward
  does, because a re-watch is a new crossing.

Camera: one slot, no queue, and a 1200 ms floor between moves, so a burst of
completions produces one move rather than walking the camera across five cards.
In replay the celebration moves nothing at all — the existing follow effect
already frames every recorded task step, and two owners of one camera is exactly
how it thrashes. A completion on a card the current filters keep off the stage is
silent: no filter is opened and no scope is changed.

## Risks

- A fast-forward seek that jumps *over* a completion does not celebrate it; only
  the event the cursor lands on is checked. Accepted — the alternative is firing
  a burst of celebrations for a range the user scrubbed past.
- Experiment 1 (`TrafficOrbit`) gets nothing. It has no replay cursor, no
  per-card DOM and its own WebGL renderer; bolting this on is a separate change.
- The burst uses CSS `sin()`/`cos()`. Supported by the WebKit and Chromium
  versions the app ships against; a browser without them renders the pieces
  stacked at the origin, which degrades to roughly the reduced-motion look.

## Alternatives considered

- **`lifecycleStartedAt` for the duration** — rejected above: a reopen resets it,
  so replay would print the wrong cycle.
- **Deriving completion from `task.status`** — cannot distinguish "just
  completed" from "completed last week", and has no meaning at a replay cursor.
- **A generic particle system / an animation dependency** — rejected for an
  effect this small. The WebGL particle engine in `orbit-engine.ts` belongs to
  Experiment 1 and cannot draw onto Experiment 2's DOM cards.
