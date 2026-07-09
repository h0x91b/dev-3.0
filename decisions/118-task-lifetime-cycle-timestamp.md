# Task lifetime cycle timestamp

## Context

Productivity Stats needs elapsed time from a task's first `in-progress` move to completion, including a fresh cycle after reopening a completed task. Existing tasks persist only their current status and latest `movedAt`, not a status-transition history.

## Investigation

`Task.movedAt` is replaced on every rendered-column move in `data.ts`, so it cannot recover the first active timestamp after a task has moved through review states. Reconstructing from task files or terminal state would be inaccurate and unavailable for historical completed tasks.

## Decision

Persist optional `Task.lifecycleStartedAt`, set by `data.ts` on a task's first `in-progress` move and reset when a terminal task is reopened into `in-progress`. `productivity-stats.ts` forwards it and the renderer aggregates only completed tasks with a valid timestamp.

## Risks

Completed tasks from before this field shipped have no valid lifetime and are omitted until new cycles complete. The UI explicitly shows a tracking/period empty state rather than inferring fake history.

## Alternatives considered

Use `createdAt` or `movedAt`: both measure the wrong interval after any status move. Add a complete event log: more data and migration surface than the requested metric needs.
