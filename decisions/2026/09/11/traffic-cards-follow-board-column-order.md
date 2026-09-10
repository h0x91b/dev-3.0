# Agent traffic orders cards by board column, and drops silent To Do cards

## Context

Experiment 2 of Agent traffic (`TrafficNodes`) laid its task cards out by `seq`
alone. On a busy board that reads as noise: a finished task from last week sits
next to the coordinator while the task actually running is three rows down, and
the backlog (To Do) fills the grid with cards that have never said anything.

## Investigation

The board already owns a column order: `getBoardColumns` in `src/shared/types.ts`
merges every visible project's columns into one display order, honours a user's
`columnOrder`, hides columns that do not apply, and keeps an occupied column
standing. Nothing about a lifecycle needed inventing — the stage only had to read
that order. The historical status at a replay cursor was also already solved, by
`projectTaskAt` in `agent-traffic/task-history.ts`.

## Decision

`agent-traffic/kanban-order.ts` turns `getBoardColumns` into two answers about a
node: `rank` (index of its column, so rank 0 is nearest the coordinator) and
`todo` (its column at the cursor is the built-in To Do lane). `layoutTraffic`
takes it as `options.board`, sorts by rank before `seq`, and filters To Do cards
out of the scene. `TrafficNodes` builds it from its existing `projections` map, so
the column is read at the playback cursor and the live status never leaks into
historical ordering.

To Do is hidden unconditionally — a message it exchanged does not buy it a card.
That is not an oversight about dangling wires: an edge is only routed when BOTH
endpoints have a position (`positions.get` in `layoutTraffic`), so a hidden
endpoint takes its wire off the stage with it, and the message log and the replay
timeline keep every row regardless. A conversing To Do card was allowed on stage
in the first version of this change; it was removed as an unrequested exception.

One deliberate carve-out:

- **A card whose column cannot be resolved sorts after every column**: the user
  marker (no task), a ghost the message log remembers but the board no longer
  holds, and a task whose `movements` never recorded the cursor's instant. Rank is
  `columns.length`. Guessing one of these into a lane would be a claim about
  history that nothing supports, and it keeps the user marker exactly where it
  already sat (last), so Seq1869's work on that marker is untouched.

## Risks

Card order now depends on the replay cursor, so scrubbing re-flows the grid where
it previously only faded cards in. That was a documented invariant in
`TrafficNodes` ("the layout must stay frozen while cards appear") and the comment
is updated: appearing still never re-flows, ordering deliberately does. On a
window with heavy status churn a scrub therefore animates card positions. The
"keeps the layout still" expectation in `agent-traffic-ui.test.tsx` still holds
because a card's rank does not change across its own creation step — the frozen
box is guaranteed for an unchanged rank, not for every scrub.

Hiding To Do applies to replay too, so a task that sat in the backlog at the
cursor is absent from the reconstructed stage. That fixture in
`agent-traffic-ui.test.tsx` was therefore born into Your Review instead of To Do;
every case it covers (no future-status leak, forwards/backwards symmetry, an
unknown past, a card withheld until its recorded creation) is unchanged and still
asserted — only the status it starts from moved to one the stage draws.

## Alternatives considered

- **A hardcoded lifecycle array in the traffic module.** Rejected: it would
  silently disagree with a user who reordered their board, and would need editing
  every time a column is added.
- **Order by live `task.status` even under replay.** Rejected outright — it is the
  exact leak `task-history.ts` exists to prevent.
- **Keep a conversing To Do card on stage** so its wire has an endpoint. Shipped
  first, then removed: the ask was no To Do cards, full stop, and the wire concern
  turned out to be unfounded — an unplaced endpoint drops its own edge.
