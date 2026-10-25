# Rank the switcher's Home group by task lifecycle activity, not movedAt

## Context
The header project switcher listed Home (projects in no space) in board order, so dozens of dormant projects buried the ones in use. Ranking needs a "last real activity" per project from data the menu already loads (`getTasks` per project, used for the "N active" counts).

## Investigation
On live data, `updatedAt` churns on runtime/session writes, and a live task's `movedAt` is refreshed by agent hooks on every turn. On 2026-10-25 one broadcast `dev3 message` woke forgotten agents in ~8 dormant projects; their Stop hooks moved the cards, and by `movedAt` all of them looked active "today".

## Decision
`taskLastActivityMs` (`src/mainview/utils/projectActivity.ts`) takes the max of `createdAt`, `lifecycleStartedAt`, `movedAt` only for completed/cancelled tasks, and any `focusByHour` hour with ≥ 1 min of real on-screen attention. A project's activity is the max over its tasks; `orderByRecentActivity` sorts descending with a stable sort, so ties and task-less projects keep board order. Only the Home group is ranked (`groupProjectsForSwitcher`); spaces, Operations, ⌘N and the no-spaces flat list keep board order. `GlobalHeader` snapshots the ranking once per opening and never re-applies it after the user steers.

## Risks
A task started long ago and worked on only through the CLI, without the board open, ranks by its start date. Tasks older than the focus tracker contribute only create/start/finish times.

## Alternatives considered
`max(createdAt, movedAt)` — simplest, but polluted by hook moves as above. The ⇧⌘K project-jump MRU (`recentProjects.ts`) — measures navigation, not task work, and is capped at 16. Today/week/month bucket headings — more chrome for the same ordering.
