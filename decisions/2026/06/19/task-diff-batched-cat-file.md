# 074 — Batched cat-file for task diff, no server-side hunks

## Context
Opening the diff for a large changeset (reported: a 185-file refactor) took 10s+.
`buildTaskDiffFiles` in `src/bun/git.ts` looped files sequentially, spawning per
file: `git cat-file -s` + `git show` per ref side for content, plus one
`git diff -- <path>` for the unified patch (hunks). That is ~3 (uncommitted) to
~5 (branch) git processes per file, run strictly one after another — ~540–900
fork/exec + repo-open cycles for 180 files.

## Decision
Reworked `buildTaskDiffFiles` (`src/bun/git.ts`) to use a constant number of git
processes regardless of file count:
- **Content**: `readRefBlobsBatch` reads all blobs at a ref via `git cat-file
  --batch-check` (sizes/existence) then `--batch` (length-prefixed content) — one
  pair of processes per distinct ref. Worktree-side files are read from disk
  concurrently (`mapWithConcurrency`, cap 24).
- **Per-file stats**: one `git diff --numstat -z` (`getNumstat`) maps path →
  insertions/deletions; new `insertions`/`deletions` fields on `TaskDiffFile`.
  Untracked files (absent from numstat) count every line as an insertion.
- **Hunks dropped**: `hunks` is now always `null`. The renderer already falls
  back to `@git-diff-view`'s `generateDiffFile(old, new)` when `hunks` is null
  (`TaskDiffViewer.tsx`), so it computes the diff client-side from content.

## Risks
- `--batch` output is parsed positionally (header line + `<size>` bytes + `\n`),
  binary-safe and aligned to input order. A malformed header is treated as a
  missing object. Covered by `git-branch-ops`, `git-diff-rename`,
  `git-diff-batch` tests.
- The renderer's diff may differ cosmetically from git's (different algorithm),
  but content and numstat counts are authoritative.

## Alternatives considered
- **Parallelize the existing per-file loop** — simpler, but still hundreds of
  spawns; only divides wall-clock by the concurrency factor.
- **One whole-range `git diff` split into per-file patches** — keeps hunks but
  splitting a unified diff by file (renames, spaces, binary) is fragile; numstat
  is robust and the renderer doesn't need hunks anyway.
