# 082 — TOCTOU-safe stale-lock breaking in withFileLock

## Context

`withFileLock` (`src/bun/file-lock.ts`) guards `tasks.json` / `projects.json` etc.
`~/.dev3.0/` is explicitly multi-process (desktop app + CLI hooks + side-by-side
versions). The old `tryBreakStaleLock` did `statSync` then an unconditional
`rmdirSync(lockDir)`. Two processes that both saw a stale lock could both remove
it; worse, one could remove a lock the other had *already re-acquired* (ABA),
putting two holders in the critical section at once → silent last-writer-wins
data loss. A secondary bug: the bare `catch` returned `true` on *any* stat error
(e.g. EACCES), and because `acquireLock` does `continue` after a successful break
(skipping the deadline check), this spun in a tight, non-yielding infinite loop.

## Decision

Break stale locks via **atomic claim + re-validation** (`tryBreakStaleLock`):
1. `stat` → if fresh, return false (leave it).
2. `rename(lockDir → <lockDir>.stale.<pid>.<ts>.<seq>)` — atomic, so only one
   breaker wins; losers get ENOENT and fall back to a clean `mkdir` race.
3. Re-`stat` the isolated graveyard: if it is actually fresh, this was an ABA —
   `rename` it back and return false (don't break a live lock).
4. Otherwise `rmdir` the graveyard; the canonical path is now free.

The bare catch is narrowed to ENOENT only; other errors are rethrown so the
caller surfaces them instead of looping forever.

## Risks

- Crash between rename and rmdir leaves an orphan `<file>.lock.stale.*` dir
  (harmless litter; never sits at the canonical lock path).
- A 3-way race can make the ABA restore fail; we log and leave the claimed dir
  rather than risk deleting a live lock. Astronomically rare and no worse than
  the pre-fix baseline.
- Directory inode/mtime jitter: we rely on mtime age, not inode identity.

## Alternatives considered

- **Plain rename-claim (no re-validation):** rejected — it still loses the ABA
  case (the loser renames whatever is at the path, including a fresh re-acquire).
- **Inode-identity check:** viable but inode reuse and platform variance make
  mtime re-validation simpler and sufficient.
- **Rewriting the lock protocol (lockfile with pid/nonce payload):** rejected —
  breaks the frozen on-disk format older versions sharing `~/.dev3.0/` must read
  (see CLAUDE.md "On-disk data layout — hard invariants").

## Backward compatibility

The canonical lock stays a plain `<file>.lock` directory created via `mkdir`.
Old versions still acquire/release/stale-break it. The graveyard is a transient
sibling old versions never inspect; after a crash mid-break the canonical path is
simply absent (acquirable by plain `mkdir`). No renamed canonical paths, no new
required files, no schema changes — downgrade-safe. Covered by compat tests in
`__tests__/file-lock.test.ts` and the race repro in
`__tests__/file-lock-stale-toctou.test.ts`.
