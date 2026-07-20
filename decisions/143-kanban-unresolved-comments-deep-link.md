# 143 — Carry Kanban unresolved-comment intent through task navigation

## Context

Task view PR popovers already open the inline branch diff at the first unresolved GitHub review thread. Kanban card popovers had no active diff surface, so their unresolved-comment row remained informational.

## Investigation

Selecting a task changes the `useTaskInlineDiffState` key and clears any request opened before navigation completes. The board must therefore carry a one-shot intent through the route transition while preserving the configured split/fullscreen task-open mode.

## Decision

Add the transient `openUnresolvedComments` route flag and consume it once in `ProjectView` or `TaskWorkspaceView`, using the shared `createUnresolvedCommentsDiffRequest` helper. Keep the existing popover row and `onShowUnresolved` callback as the only new wiring surface.

## Risks

The flag is part of route history, so returning to a deep-link route can reopen the diff by design. A per-route task key prevents manual diff close from immediately reopening it.

## Alternatives considered

Opening the GitHub PR URL would not match the existing Task view behavior. A timeout or global event would be race-prone across the route transition, so the route intent is explicit and testable.
