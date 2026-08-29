# Active Tasks sidebar gets the PR badge, but not the board's PR discovery poll

## Context

The Kanban card, the task info panel and the info panel's git bar all carry the pull-request
badge cluster (number, mergeability, review verdict, unresolved comments). The Active Tasks
sidebar did not, and a comment in `ActiveTasksSidebar.tsx` explained why: "the sidebar tracks no
live PR map". Read as a constraint, that comment says the badge needs a network channel the
sidebar does not have.

## Investigation

It does not. PR state reaches the renderer through two channels, and neither belongs to the board:

1. **Persisted on the task.** `task.prNumber` / `task.prUrl` carry identity; `task.prStatusCache`
   (`TaskPRStatusCache`) carries CI status, review state, unresolved count, merge state, the check
   list, the PR title and the draft flag. The backend `prWatch` activity writes both through the
   `persistPrStatus` effect (`src/bun/lifecycle/executor.ts`). Any surface holding a `Task` already
   holds everything the four badges need.
2. **The `taskPrStatus` push.** A renderer-wide `window` CustomEvent emitted on `prDetected`
   (`src/bun/lifecycle/machine.ts`). Every mounted surface can subscribe.

The board's `getProjectPRs` poll adds exactly one thing on top: **discovery** — matching a branch
name to an open PR for a task whose sticky identity was never persisted. It is per project every
60 s, not per card.

## Decision

The sidebar renders the badge from the two free channels and does **not** take the discovery poll.
`useTaskPrBadges` (`src/mainview/hooks/useTaskPrBadges.ts`) takes `discoverProjectIds` as an
opt-in; `KanbanBoard` passes its board projects, `ActiveTasksSidebar` passes nothing.

The number is the whole argument: the board's poll fans out to **one** project (or a space's
members), while the sidebar in global scope spans **every** project on the machine — the same code
would fire one `gh` invocation per project per minute, dozens on a busy dashboard, to recover data
three other paths already persist. Identity is written independently by the board poll
(`persistProjectPrIdentities`), by `getTaskGitStatus`'s probe
(`src/bun/rpc-handlers/git-operations.ts`), and by peer-review `prWatch` in the review columns.

The badge cluster itself moved into `TaskPrBadges.tsx` and both surfaces render that one component,
so they cannot drift.

## Risks

A pull request that no board visit, no git-status fetch and no peer review has ever touched shows
no badge in the sidebar. That is today's behaviour rather than a regression, and it degrades
honestly: a task with identity but no polled state shows the number alone — never a spinner, never
a guessed approval. Every badge past the number is independently null-guarded.

The subtle one: `prDetected` pushes `taskPrStatus` but **not** `taskUpdated`. A surface that
listens only to `taskUpdated` — as the sidebar did — would show a `prStatusCache` that goes stale
mid-session. `useTaskPrBadges` owns that listener so no future surface has to rediscover it.

## Alternatives considered

- **Give the sidebar the same poll.** Rejected on the fan-out above.
- **Lift the PR map to a common owner (App/state).** Buys nothing today: the board's poll is the
  only network consumer, and a shared owner would still have to decide which projects to poll for.
  Worth revisiting only if a third surface needs discovery.
- **Number-only badge, no status colour.** Rejected as unnecessarily degraded once it was clear the
  full cache is already on the task.
