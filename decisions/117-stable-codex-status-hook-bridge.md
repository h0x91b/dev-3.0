# 117 — Codex Worktree Hooks Use Scoped Automatic Trust

## Context

The original Codex integration generated status commands in every worktree. Current Codex requires hash-based trust for each non-managed command hook, so every generated source path needs a matching trusted hash; the old dual `Stop` groups also raced because matching handlers run concurrently. A global `~/.codex/hooks.json` would avoid per-path hashes but would make dev3 modify user-owned global hook definitions.

## Investigation

Codex exposes `PermissionRequest` from rust-v0.122.0 alongside `SessionStart`, `UserPromptSubmit`, tool hooks, and `Stop`; rust-v0.121 ignores the unknown event key without dropping the remaining hooks. Hook hash enforcement arrived in rust-v0.129.0, and `hooks/list` exposes the authoritative key, source, command, current hash, and trust status. Codex 0.143 deliberately redirects hook discovery for linked worktrees to the root checkout, but session-flag hook declarations and hook state remain process-local and take precedence.

## Decision

Generate `.codex/hooks.json` inside each managed worktree, with every lifecycle event calling `dev3 hook codex`, then mirror those dev3 definitions into every launched Codex pane through a `-c hooks=...` session override inserted immediately after the Codex binary, before any prompt terminator or resume subcommand. Before launch, query `hooks/list` with the same override, accept hashes only for `sessionFlags` entries whose command exactly equals the dev3 adapter, and include their trust state in the final override; nothing is persisted globally. The CLI adapter always returns `{}` and forwards events to one atomic `task.agentHook` socket operation, while a short-lived per-session marker restores an approving review agent to `review-by-ai` after `PostToolUse`.

## Risks

Automatic trust depends on Codex's local app-server protocol; older versions without `hooks/list` receive the hook definitions without state because they also predate hash enforcement. A future protocol change degrades to Codex's normal review UI rather than broad trust. Each Codex pane performs a short hash-discovery launch before the real session, and the adapter intentionally ignores board-sync failures so an offline dev3 instance cannot block the coding agent.

## Alternatives considered

Writing `~/.codex/hooks.json` was rejected because it mutates a user-owned global definition file. Persisting per-worktree hashes in `~/.codex/config.toml` was rejected because stale trust metadata would accumulate after worktree deletion. A separate `CODEX_HOME` was rejected because it also isolates authentication, profiles, skills, and session history; `--dangerously-bypass-hook-trust` trusts unrelated hooks, while reproducing Codex's hash algorithm is brittle.
