# 084 — Capture per-task LOC at completion (productivity dashboard)

## Context

The Productivity Stats dashboard needs "lines of code changed" per task, summed over time. A task's git diff lives in its worktree, which is **deleted** when the task moves to `completed`/`cancelled` (`moveTask` → `git.removeWorktree`). After that the diff is unrecoverable. We needed a way to retain LOC that survives worktree cleanup, using local git only.

## Decision

Capture diff stats **once, at completion time, before the worktree is removed**, and persist them on the task.

- New `Task.completedDiffStats?: CompletedDiffStats` (`{ files, insertions, deletions, capturedAt }`) in `src/shared/types.ts`.
- `captureCompletedDiffStats(project, task)` in `task-lifecycle.ts` runs inside `moveTask` right before `git.removeWorktree`, only for non-virtual tasks with a worktree. It compares `git diff --numstat <ref>...HEAD` (three-dot) against `origin/<base>` — the same ref the diff viewer's "branch" mode uses — falling back to the local `<base>` branch when no origin ref exists. Best-effort: wrapped in try/catch, never blocks completion.
- New RPC `getProductivityStats` (`rpc-handlers/productivity-stats.ts`) aggregates per-task stat events across all git + virtual projects. Completed tasks use the captured snapshot; **active** tasks get a live worktree diff so in-flight work counts immediately. The renderer buckets events by the selected time range client-side (one fetch, instant range switch).

## Why three-dot against `origin/<base>`

Three-dot (`A...HEAD`) measures from the merge-base, so it reports exactly what the branch added since it diverged. The repo squash-merges PRs, so even after a merge `origin/<base>` does not contain the branch's original commits → the merge-base stays at divergence → the full branch diff is still measured. (A true non-squash merge would collapse it to ~0; accepted edge.)

## Risks / limitations

- **Forward-only:** tasks completed *before* this shipped have no captured stats (worktree already gone). LOC accrues from ship time; the UI shows a "tracking since" empty state. Historical backfill from surviving `diffs/*.patch` snapshots was explicitly left out of scope (user decision 2026-06-28).
- Live diff for active tasks spawns git per active worktree on each stats load (range switching is client-side, so only on open/refresh). Bounded by active-task count; best-effort, errors → 0.
- `movedAt` is the completion timestamp proxy (terminal status = last move). A reopened-then-recompleted task only retains its last `movedAt` — acceptable for 95%+ of tasks; no per-status history added.

## Alternatives considered

- **Separate stats file / notes** — rejected: schema proliferation vs. one optional field on the task.
- **Compute all LOC live on dashboard open** — impossible for completed tasks (worktree gone); only viable for active ones (which we do).
- **Add `statusHistory[]`** for exact completion audit — over-scoped; `movedAt` suffices.
