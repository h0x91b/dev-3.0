# Traffic stage eligibility is per project, not per message count

## Context

Experiment 2 of Agent traffic (`TrafficNodes` / `layoutTraffic`) opens on "the
conversation alone": tasks that exchanged nothing in the window are counted into a
collapsed quiet band instead of drawn, which is what stopped a 43-task board from
burying its four messages.

Applied globally, that rule also decides whether a *project* exists: on an
all-projects view a board with zero messages in the window was silently missing,
group box, cards and all. With a single conversing project left, `grouped`
(`projectIds.length > 1`) then went false and even that project lost its named
block.

The bug was reported as "projects without a coordinator are omitted", and it is
worth being precise about that: what was measured is the zero-message rule.
Whether a coordinator is the only thing that ever produces agent traffic was never
verified and is not what this record claims — a coordinator-less board that does
exchange messages was always drawn.

## Investigation

Reproduced in `layoutTraffic` directly: two projects, one with a coordinator and one
message, one with two ordinary tasks and none. Result: `placed` held only the first
project's two cards, `groups` was `[]`, `quietCount` was 2. Cause is the
zero-message eligibility filter (`active = awake.filter(node => messages.has(...))`),
not anything reading `taskType === "coordinator"` — nothing in selection, rendering
or the project-visibility filters keys on a coordinator.

## Decision

In `layoutTraffic` (`src/mainview/components/agent-traffic/nodes-layout.ts`),
eligibility is computed per project: a project with no message-carrying awake node in
the window has all of its awake tasks promoted into the conversation band, so it gets
its own group with ordinary cards. Those promoted tasks leave the quiet band, so
`quietCount` stays honest and nothing is drawn twice.

Nothing else changes: no coordinator node or relationship is invented, hibernated and
completed tasks keep their existing treatment (a project holding only hibernated tasks
still earns no block), and eligibility reads the whole window's records — which
`TrafficNodes` passes as `layoutRecords` independently of the replay cursor — so card
positions do not move as a replay advances.

## Risks

A silent project draws every one of its awake tasks, so a board with many awake,
never-messaging tasks gets a large block. It sits in its own group and buries no
conversation, which is the reasoning the quiet band was built on, but if such a block
becomes unwieldy the fix is a per-project cap folding the remainder back into the
quiet band — not a return to zero-message eligibility.

## Alternatives considered

- Draw a named but empty placeholder block for a silent project and leave its cards to
  the quiet toggle. Honest, but an empty box answers none of the questions the stage
  exists to answer.
- Promote only the first row (five cards) per silent project. Bounded, but invites
  "why only five of my tasks" with no visible reason; kept in reserve as the risk
  mitigation above.
