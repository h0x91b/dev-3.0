# 117 — Codex Status Hooks Use a Stable User-Level Bridge

## Context

The original Codex integration generated status commands in every worktree. Current Codex requires hash-based trust for each non-managed command hook, so the worktree-specific source path forced repeated review and could leave hooks silently skipped; the old dual `Stop` groups also raced because matching handlers run concurrently.

## Investigation

Codex exposes `PermissionRequest` from rust-v0.122.0 alongside `SessionStart`, `UserPromptSubmit`, tool hooks, and `Stop`; rust-v0.121 ignores the unknown event key without dropping the remaining hooks. Hook hash enforcement arrived in rust-v0.129.0, and the persisted trust key includes the source path, event, group index, and handler index. A `Stop` hook accepts `{}` as a successful no-op, while a user-level hook can safely run outside dev3 if its adapter treats missing task context the same way.

## Decision

Install one stable hook set in `~/.codex/hooks.json`, with every lifecycle event calling `dev3 hook codex`. The CLI adapter always returns `{}` and forwards supported events to one atomic `task.agentHook` socket operation, which selects `in-progress`, `user-questions`, `review-by-ai`, or `review-by-user` from the locked current task state. A short-lived per-session resume marker restores an approving review agent to `review-by-ai` after `PostToolUse` instead of restarting the primary-agent flow.

## Risks

Users must approve the stable definitions once through `/hooks` for each Codex profile. The adapter intentionally logs and ignores board-sync failures so an offline or broken dev3 instance can never block the coding agent. Restarting dev3 during an outstanding review-agent approval loses the in-memory resume marker; the completed tool then safely falls back to `in-progress` rather than guessing that the review is still active.

## Alternatives considered

Automatically writing Codex's internal trusted hashes was rejected as an undocumented security bypass. `--dangerously-bypass-hook-trust` was rejected because it would trust unrelated repository and plugin hooks, and retaining two `Stop` commands was rejected because concurrent execution cannot provide ordered review transitions.
