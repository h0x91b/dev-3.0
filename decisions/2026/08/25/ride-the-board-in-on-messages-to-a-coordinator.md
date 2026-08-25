# Ride the board in on messages to a coordinator

## Context

`COORDINATOR_PROMPT` used to admit the problem outright: "YOUR PICTURE OF THE
BOARD IS A SNAPSHOT, not a feed… re-read the board before every status." That is
a discipline rule, enforced by the model remembering it, and it costs a tool call
every time it works.

The problem this record solves is the narrow one: **a coordinator being spoken to
does not know what changed on the board since it was last spoken to.** A child
reports "done", and the coordinator relays a status built on everything else it
believes — much of which moved while it sat idle.

## Investigation

Three candidate seams:

1. **`UserPromptSubmit` hook.** dev3 already installs one for Claude and Codex,
   and Claude folds a hook's stdout into the turn — verified live, the existing
   `dev3 task move` hook's own output already reaches the agent's context. It
   covers *every* turn including the user's own typing, and writes to the context
   rather than the pane. Built, then **removed at the user's direction**: he did
   not want the board mechanism to depend on hooks.
2. **The delivery seam** (`deliverToTarget` → `deliverAgentPrompt`). Covers every
   message dev3 delivers, on every harness and both terminal backends, with no
   hook and no harness-specific behaviour. Misses the user typing straight into
   the pane, because those keystrokes reach the pty directly (`pty-server.ts`).
3. **A timer pushing the board into the pane.** Rejected: text plus Enter wakes an
   agent up, so a board arriving on its own would make the coordinator chatter.

## Decision

Option (2). Notifying a coordinator that something changed *without* a message to
carry it is a different problem, deliberately left open.

- `shared/coordinator-board.ts` — contract plus the pure renderer.
- `bun/coordinator-board.ts` — `collectCoordinatorBoard` (live tasks sorted by
  `compareTaskSortRank`, plus a rolling 24 hours of finished ones) and
  `coordinatorBoardEpilogue`, which returns "" for anything but a coordinator and
  for every failure.
- `AgentPromptEpilogue` on `deliverAgentPrompt`: a trailer typed once at the END
  of the turn, after every message and before the single Enter.
- `HeldAgentMessage.epilogue` carries it through the hold. One hold is one agent
  turn, so it holds one epilogue, and the newest registration wins it — the same
  rule `submit` already followed, for the same reason (freshest pane pin).

Two properties the design turns on. The trailer is **lazy**: it is a function
called at typing time, so a message that waited a full hold window still ends on
a board that is seconds old. And it is **subordinate**: a trailer that throws
costs the trailer, never the message or its Enter.

## Risks

- **The user's own message carries no board.** The largest remaining gap, and the
  one the prompt now names explicitly: re-read the board before answering him
  after a silence. Closing it needs a hook, which is out of scope by decision.
- **The native arm folds the trailer in at send time, not release time**, so a
  held native message can carry a snapshot up to one hold window old. Its delivery
  closure may be forwarded to whichever process owns the pane's writer lease, and
  a closure does not cross a process boundary; a stale trailer beats one that
  silently vanishes.
- **The right-hand column shipped as terminal quiet time and was wrong.** Replaced
  the same day by column age; the measurements are in
  `board-age-is-column-age-not-terminal-silence.md`.
- **The trailer is visible in the pane**, unlike the hook version. Measured on a
  1762-task board: 7 live + 3 finished rows, ~1.4 KB.

## Alternatives considered

- **Appending the block to each message in `deliverToTarget`** — a burst of three
  messages is one turn and would have carried three copies of one table.
- **Delta instead of a full list** — useless after a context compaction, when
  there is no earlier snapshot to compare against.
- **Marking changed rows with `*`** — needs the previous snapshot kept somewhere;
  the user explicitly did not want that state, and the finished-in-24h section
  buys the delta that actually matters.
- **Calendar-day window for finished tasks** — resets at midnight, so a morning
  coordinator loses the previous evening. A rolling 24 hours does not.
- **Cross-project boards** — bytes in every message; scoped to the task's own.
