# 127 — PR Review always belongs in NEEDS YOU

## Context

The Active Tasks sidebar placed a PR Review task in `WAITING` unless it carried a live bell.
That buried quiet reviews among active agents and AI review runs, even though a pending PR still needs human attention.

## Investigation

`groupTasksIntoTiers` and the `is:attention` facet shared a signal-gated `isAttentionTask` rule.
The same rule drove the sidebar's top tier, attention-only view, and board filter, so changing only the rendered group would make the views disagree.

## Decision

Treat every `review-by-colleague` task as an attention status in `taskFacets.ts`.
`sidebarTiers.ts` now keeps all PR Review tasks in `NEEDS YOU`; bell counts remain visual notification state and do not affect ordering.

## Risks

The top tier can grow when many PRs are pending, but priority and age still order it predictably.
The alternative would hide a real review obligation until an unrelated event happens, which is worse for the queue's purpose.

## Alternatives considered

Keep signal-gated promotion and add a separate PR section. Rejected because it creates a fourth queue category and makes quiet reviews easy to miss.
