# 042 — Prefer the account shell over a stale `SHELL` env

## Context

Issue #491 looked fixed after importing more `gh` config environment from the
login shell, but the warning still reproduced for a user whose app-launched
terminals started in `/bin/bash` while their actual macOS login shell was
`/bin/zsh`. Setup scripts also failed with `bun: command not found`.

## Investigation

dev-3.0 trusted `process.env.SHELL` in several places. On macOS that value can
be stale for GUI-launched apps, so we ended up resolving PATH and `gh` config
from bash while the user's real shell configuration lived in zsh. The task
wrappers also hardcoded `bash`, which made the mismatch visible in startup and
failure panes.

## Decision

`src/bun/shell-env.ts` now reads the account shell from system user records
(`dscl` on macOS, `getent passwd` on Linux) and falls back to `SHELL` only if
that lookup fails. `src/bun/index.ts`, `src/bun/headless-entry.ts`,
`src/bun/rpc-handlers/tmux-pty.ts`, and `src/bun/rpc-handlers/task-lifecycle.ts`
use that resolved shell for shell-env bootstrap and task wrapper execution.

## Risks

The system lookup adds a small startup dependency on `dscl` or `getent`. If the
lookup fails, we intentionally fall back to the old `SHELL` behavior, so the
app degrades safely instead of blocking startup.

## Alternatives considered

- Keep trusting `process.env.SHELL`. Rejected because it is exactly what let
  GUI app launches drift away from the user's real login shell.
- Hardcode zsh on macOS. Rejected because bash is still valid for some users
  and Linux needs a portable account-shell lookup instead of Apple-only logic.
