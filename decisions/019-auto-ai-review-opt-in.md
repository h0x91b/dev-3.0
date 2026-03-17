# 019 — Automatic AI Review as an Opt-In

## Context

Issue #336 first exposed a bug in the existing "AI Review" project setting: turning it off in repo config or local overrides did not persist, so the settings page reopened with AI Review enabled and tasks still went through automatic review. Once that persistence bug was clear, the follow-up product need was to separate automatic review after task completion from the manual "AI Review" Kanban column so users could still drag tasks there on demand.

## Investigation

The persistence bug came from the settings flow not storing an explicit automatic-review value that matched the user's intent, so reopening Project Settings reconstructed AI Review as enabled. The backend already defaulted primary task completion to `review-by-user` in [rpc-handlers.ts](/Users/tome/projects/dev-3.0/src/bun/rpc-handlers.ts), but the settings UI still treated AI Review as an enable/disable switch for the manual column agent. Separately, the generated dev3 skill text in [agent-skills.ts](/Users/tome/projects/dev-3.0/src/bun/agent-skills.ts) still instructed non-hook agents to finish in `review-by-ai`, which kept automatic review alive for some agent flows.

## Decision

Added a dedicated `autoReviewEnabled` project config field in [types.ts](/Users/tome/projects/dev-3.0/src/shared/types.ts) and [repo-config.ts](/Users/tome/projects/dev-3.0/src/bun/repo-config.ts), defaulting to `false`, so the saved repo/local settings now faithfully preserve "automatic AI review off". In [ProjectSettings.tsx](/Users/tome/projects/dev-3.0/src/mainview/components/ProjectSettings.tsx), the toggle now controls only automatic review, while the AI Review column agent settings remain always configurable for manual drag-to-review.

## Risks

This partially reopens the "optional auto-review" path that decision 017 rejected, so there are again two completion paths to maintain. The deterministic automatic path is intentionally narrow: Claude uses hook stop targets, while non-hook agents still end in `review-by-user`, so "automatic AI review" currently only guarantees hook-capable agents.

## Alternatives considered

- Keep AI Review manual-only and merely relabel the toggle: rejected because the user explicitly wanted automatic review to remain available as an opt-in.
- Keep the old toggle semantics and add a second setting elsewhere: rejected because it would preserve the confusing coupling between manual column review and automatic completion review.
