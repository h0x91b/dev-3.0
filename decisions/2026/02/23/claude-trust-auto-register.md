# 001: Auto-register worktree paths as trusted in ~/.claude.json

**Date:** 2026-02-23
**Status:** Implemented

## Context

When Claude Code CLI launches in a directory it hasn't seen before, it shows an interactive "Do you trust the contents of this directory?" dialog. Since every new task creates a fresh git worktree with a unique path, this dialog appears every single time — blocking the agent from starting automatically.

There is no official CLI flag or config to skip the trust dialog for new directories. The `--dangerously-skip-permissions` flag works but also disables all other permission checks, which is too aggressive. A feature request for trusted workspace patterns exists (https://github.com/anthropics/claude-code/issues/23109) but is not implemented as of Feb 2026.

## Investigation

By reverse-engineering the Claude Code binary (`strings` on the compiled executable), we found:

- Trust state is stored in `~/.claude.json` under `projects.<absolute-path>.hasTrustDialogAccepted`
- The CLI resolves symlinks before looking up the path (important: on macOS `/tmp` → `/private/tmp`)
- The CLI walks up parent directories checking for trust, but this doesn't help for worktrees in temp dirs
- Manually adding an entry with `hasTrustDialogAccepted: true` before launching `claude` successfully skips the dialog (verified experimentally)

## Decision

Before launching a PTY session, we read `~/.claude.json`, resolve the worktree path (handling symlinks), and write a trust entry if one doesn't exist. This happens in `ensureClaudeTrust()` in `src/bun/agents.ts`, called from `launchTaskPty()` in `src/bun/rpc-handlers.ts`.

## Risks

- **Undocumented API**: `~/.claude.json` format is not a public API. Anthropic could change it.
- **Race condition**: Multiple agents writing `~/.claude.json` concurrently could corrupt it. Currently mitigated by the fact that worktree creation is sequential, but worth watching.
- **Security**: We auto-trust directories we created ourselves, which is reasonable — the user already approved the project.

## Alternatives considered

1. `--dangerously-skip-permissions` — too broad, disables all permission checks
2. Shell wrapper that patches `~/.claude.json` before each `claude` invocation — same mechanism but external to the app
3. Wait for official `trustedWorkspacePatterns` feature — indefinite timeline
