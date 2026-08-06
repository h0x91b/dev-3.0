# 078 — Exclude the worktrees root from OS backups

## Context

`~/.dev3.0/worktrees` holds per-task git worktrees, each with full CoW-cloned
`node_modules`/build directories — easily 100GB+ of ephemeral data whose
committed state already lives in git. Time Machine backing this up is pure waste
that slows every backup.

## Decision

Added `ensureWorktreesBackupExclusion()` (`src/bun/backup-exclusion.ts`), called
once at app startup from both entry points — desktop (`src/bun/index.ts`) and
headless/remote (`src/bun/headless-entry.ts`), fire-and-forget after the shell
env/PATH is patched. It excludes the **whole** worktrees root in a single
`tmutil addexclusion <worktreesRoot>` call (per-task subfolders inherit it),
guarded once per process (in-memory), and is a no-op on Linux. No setting — the
behavior is unconditional; users who want backups can remove the exclusion with
`tmutil removeexclusion ~/.dev3.0/worktrees`.

We deliberately use `tmutil addexclusion` **without** `-p`: the path/sticky form
(`-p`) requires root, whereas the plain form sets a per-user xattr exclusion
(`com.apple.metadata:com_apple_backup_excludeItem`) that needs no privileges and
is idempotent (re-adding is a no-op).

## Risks

- The exclusion is a best-effort xattr; if a user later clears it manually, the
  next worktree creation in a fresh app session re-applies it (the guard is
  in-memory only, and a failed `tmutil` call leaves the guard unset so it
  retries).
- Existing installs only get the exclusion on the next worktree creation, not
  retroactively for trees already present — acceptable, since the bulk of the
  data is the root they all share.

## Alternatives considered

- **Apply inside `createWorktree`** (on first worktree creation): works and is a
  single chokepoint, but excludes the folder lazily. Rejected in favor of doing
  it once at startup — simpler mental model ("exclude the whole folder at app
  start") and applies even before the first task is created.
- **Marker file under `~/.dev3.0/`** to gate the call: rejected as unnecessary —
  `tmutil addexclusion` is already idempotent and cheap, and the in-memory guard
  avoids repeat spawns within a session without touching the frozen on-disk
  layout.
