# Worktree agent config: local file only, never through a symlink out of the worktree

## Context

`writeClaudeHooks` put the `Bash(dev3:*)` permission into whichever `.claude/` settings file
existed, and on a fresh worktree that was the committed `settings.json` (added in #337). Some
repos track `.claude/settings.json` as a symlink into a shared config kit, and a checkout keeps
the symlink. So every task launch rewrote the kit file through the link, in place and outside
the worktree. Nothing failed, so nobody noticed.

## Investigation

These code paths write agent config into a worktree: `writeClaudeHooks` (hooks, permission,
`defaultMode`), `ensureClaudeMcpApproved` in `src/bun/agents.ts` (MCP pre-approval) and
`writeCodexHooks`. Plain `writeFileSync` follows a symlinked file and also a symlinked parent
directory. The user-scope writers (`~/.claude/settings.json` in `agent-skills.ts` and
`low-battery.ts`) are not on this path: Claude Code reads `autoMode` only from user scope, and
they write under `$HOME`, not into a repo.

## Decision

- Everything dev3 adds for a task goes to `<worktree>/.claude/settings.local.json`, the
  gitignored local scope. `settings.json` is never written. That file is only read, for MCP
  approvals.
- Before any of the three writers touches disk, `symlinkOnWritePath` in
  `src/shared/symlink-write-guard.ts` walks from the worktree root to the target with `lstat`.
  A symlink whose real path stays inside the worktree is allowed, because a repo that keeps
  `.claude -> config/claude` edits only its own disposable checkout. A symlink that resolves
  outside the worktree, back to the root itself, or nowhere (dangling) makes the write skip with
  a warning (stderr for `dev3 install-hooks`). The worktree root itself is not checked, because
  `/tmp` on macOS is a link.
- `writeClaudeHooks` returns `{ written, skippedSymlink }` so its callers can say why it skipped.

## Risks

A repo that links `.claude/` or `settings.local.json` outside the checkout gets no dev3 status
hooks, so its tasks stop moving on the board by themselves. That outcome is visible in the log. The old one
was a silent edit to a shared file, which is worse. Repos that relied on the permission landing
in `settings.json` lose nothing: Claude Code merges `settings.local.json` on top of it.

## Alternatives considered

- **Refuse every symlink, inside or out.** Simpler, but it drops status hooks for repos that only
  rearrange paths inside their own tree, and that protects nothing.
- **Replace the symlink with a real file.** This silently mutates a tracked path in the user's
  checkout, which is the same class of surprise this fix removes.
