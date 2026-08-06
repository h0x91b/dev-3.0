# 024 — Codex Requires Exact Worktree Trust Entries

## Context

Fresh Codex sessions in dev3 worktrees started showing the terminal trust prompt again even though `~/.codex/config.toml` already trusted the shared `~/.dev3.0/worktrees` root. That broke the expected zero-click launch path for spawned Codex task worktrees.

## Investigation

The current dev3 startup patch only wrote `[projects."<home>/.dev3.0/worktrees"]` plus the dev3 permission/profile blocks. A live config check showed there was no exact `[projects."<worktreePath>"]` entry for the newly spawned worktree path that Codex displayed in the prompt.

## Decision

dev3 now keeps the shared worktrees root trust entry and also patches the exact resolved worktree path into `~/.codex/config.toml` via `ensureCodexTrust()` in [src/bun/agents.ts](src/bun/agents.ts) before launching Codex from [src/bun/rpc-handlers.ts](src/bun/rpc-handlers.ts). `ensureCodexConfig()` in [src/bun/codex-config.ts](src/bun/codex-config.ts) now accepts additional trusted paths so startup patching and per-launch patching share the same logic.

## Risks

This assumes Codex matches trust by exact project path rather than inheriting trust from a parent directory. If Codex changes that behavior again, the extra trust entries may become redundant but remain harmless.

## Alternatives considered

- Keep trusting only the shared `worktrees` root: rejected because current Codex behavior still shows the prompt for fresh per-task worktrees.
- Hardcode worktree trust edits directly in the launch path: rejected because it would duplicate TOML patch logic and drift from startup config patching.
