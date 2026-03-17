# 019 — Automatic AI Review as an Opt-In

## Context

Issue #336 exposed that the existing "AI Review" project setting mixed two different concepts: automatic review after task completion and the manual "AI Review" Kanban column. Users wanted to turn off the automatic pass without losing the ability to drag a task into AI Review on demand.

## Investigation

The backend already defaulted primary task completion to `review-by-user` in [rpc-handlers.ts](/Users/tome/projects/dev-3.0/src/bun/rpc-handlers.ts), but the settings UI still treated AI Review as an enable/disable switch for the manual column agent. Separately, the generated dev3 skill text in [agent-skills.ts](/Users/tome/projects/dev-3.0/src/bun/agent-skills.ts) still instructed non-hook agents to finish in `review-by-ai`, which kept automatic review alive for some agent flows.

## Decision

Added a dedicated `autoReviewEnabled` project config field in [types.ts](/Users/tome/projects/dev-3.0/src/shared/types.ts) and [repo-config.ts](/Users/tome/projects/dev-3.0/src/bun/repo-config.ts), defaulting to `false`. In [ProjectSettings.tsx](/Users/tome/projects/dev-3.0/src/mainview/components/ProjectSettings.tsx), the toggle now controls only automatic review, while the AI Review column agent settings remain always configurable for manual drag-to-review.

## Risks

This partially reopens the "optional auto-review" path that decision 017 rejected, so there are again two completion paths to maintain. The opt-in path is intentionally narrow: Claude uses hook stop targets, while non-hook agents rely on launch-time prompt guidance, so behavior still depends on agents respecting that instruction.

## Alternatives considered

- Keep AI Review manual-only and merely relabel the toggle: rejected because the user explicitly wanted automatic review to remain available as an opt-in.
- Keep the old toggle semantics and add a second setting elsewhere: rejected because it would preserve the confusing coupling between manual column review and automatic completion review.
