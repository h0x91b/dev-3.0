# Active-project traffic scope is read off recorded events, and never applied while loading

## Context

Agent traffic's project scope offered two shapes: every visible project, or one named
project. On a machine with twenty boards and two busy ones, the default spent the stage on
eighteen blocks holding nothing. A third scope — "All active projects", and the one a fresh
entry opens on — needed a definition of "active" that the screen can actually prove.

## Investigation

Three candidate definitions were on the table, and two are unusable:

- **Running status / a live runtime** — describes right now, not the window. A board whose
  agents worked all morning and went quiet ten minutes ago would drop out of an hour that is
  full of its work.
- **Has a coordinator** — a role, not an event. It both over- and under-counts: an idle
  coordinator keeps an empty board on stage, and a project that never used one is erased.
- **Has a recorded event in the window** — what `traffic-timeline.ts` already assembles for
  replay, and the only one made of facts the screen can cite.

The timeline's union is `task` (a movement written into `Task.movements`) plus `message` (an
agent-message-log row). Its `notification` kind is a control value with no arm behind it
(`AgentTrafficScreen.tsx`, `TimelineKind`), so notifications are deliberately not evidence
here yet — and become evidence the day that arm lands, with nothing in this code to change.

## Decision

`src/mainview/components/agent-traffic/traffic-scope.ts` owns the vocabulary and the
resolution. `activeProjectIds()` reads membership off timeline events — both ends of a
message, the owning project of a movement. `scopeProjectIds()` maps a scope value to the ids
it admits, or `null` for "no filter at all"; `admits()` is the one place `null` is read as
"everything", which keeps an empty set and an absent filter from ever being conflated.

`AgentTrafficScreen.tsx` builds one **unscoped** window timeline for this, because deriving
membership from scoped data is circular — a project filtered out could never prove it
belonged. That timeline is also independent of the replay cursor, so membership holds still
while the cursor walks the window (bible §5.9 "History is recorded events").

Two guarantees are load-bearing:

- **`ALL_PROJECTS` resolves to `null`**, so that path stays byte-identical to the unfiltered
  one it has always been — including the per-project block eligibility Seq 1827 restored in
  `nodes-layout.ts`, which this change deliberately does not touch. Narrowing happens
  upstream, on which nodes reach the stage.
- **`settled` gates the filter.** History arrives page by page; a window whose rows have not
  loaded holds no evidence in either direction. Until `useTrafficData` reports both reads
  done, `active` admits everything, so "not read yet" is never presented as "nothing
  happened". The screen's own loading readout already names that state.

`TrafficOrbit` asks `isAggregateScope()` instead of `scope === "all"`, so neither
all-project scope pins a primary lane while both still refit the camera when switched.

## Risks

- Membership widens when a live event arrives for a project that had none. That is intended
  ("recompute when events actually arrive"), and it is deliberately **not** part of the
  playback reset key: a new project appearing must not restart the reader's replay.
- A project whose movements were evicted from `Task.movements` and whose messages fell out of
  retention reads as inactive for that window. It is genuinely unrecorded there; "All
  projects" is one click away and unchanged.

## Alternatives considered

- **Filtering `data.projects` before the stages** — the stages derive their blocks from
  nodes, not from that list (`layoutTraffic`), so it would have been a second, redundant
  gate that could disagree with the first.
- **Re-deriving the window clip inside `traffic-scope.ts`** instead of consuming timeline
  events — cheaper by one timeline build, and guaranteed to drift from
  `taskEvents`/`messageEvents` the first time either changes.
- **A separate persisted setting** for the default scope — a durable preference for a beta
  screen's ephemeral view state, and the manifest keeps view state on the surface.
