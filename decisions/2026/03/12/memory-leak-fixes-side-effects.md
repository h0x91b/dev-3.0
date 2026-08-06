# 015 — Memory Leak Fixes: Potential Side Effects

## Context

A comprehensive memory leak audit (March 2026) identified 20 issues across the codebase. All were fixed in PRs #294, #295, #296, and a follow-up correction. This document lists every change and its potential side effects so future agents can quickly trace regressions back to these fixes.

## Changes and Side Effects

### PR #294 — Critical fixes (Tier 1)

| # | File | Change | Potential Side Effect |
|---|---|---|---|
| 1 | `src/mainview/components/ImageLightbox.tsx` | Plain Map → LRU cache (max 30 entries) via `cacheSet`/`cacheGet` | If user opens 30+ unique images, oldest data URLs are evicted. Reopening an evicted image triggers a fresh `readImageBase64` RPC call instead of a cache hit. Slightly slower, but correct. |
| 2 | `src/bun/rpc-handlers.ts` | `branchStatusInFlight` — was already fixed with try/finally before audit | None. |
| 3 | `src/bun/rpc-handlers.ts:302-318` | `startMergeDetectionPoller()` now calls `stopMergeDetectionPoller()` before creating a new interval | If stop is called externally at the wrong time, the poller won't run until something calls start again. Currently nothing calls stop externally. |
| 4 | `src/bun/rpc-handlers.ts:376-391` | `startPRDetectionPoller()` — same pattern as #3 | Same as #3. |
| 5 | `src/bun/rpc-handlers.ts:1437,1441,1481` | tmux `spawn()` for `select-pane` and `set-option` — changed from bare fire-and-forget to `.exited.catch(() => {})` | **Non-blocking.** The `.catch()` prevents unhandled promise rejections. If tmux fails silently (e.g., pane already gone), the error is swallowed. This is intentional — these are cosmetic tmux operations (pane titles). |
| 6 | `src/bun/rpc-handlers.ts:checkMergedBranches()` | Sweep in `checkMergedBranches()` removes stale IDs from `mergeNotifiedTasks` and `prPromotedTasks` | **Double task loading:** the sweep loads all tasks for all projects, then the main loop loads them again. Minor perf hit on the 5-minute poll, but not user-visible. If a task is deleted between sweep and main loop, the sweep correctly removed its ID. |

### PR #295 — High-priority fixes (Tier 2)

| # | File | Change | Potential Side Effect |
|---|---|---|---|
| 7 | `src/bun/rpc-handlers.ts:moveTask` | `prPromotedTasks.delete(task.id)` on any status transition + size guard (>500 → clear all) | A task that returns to `review-by-user` after moving away will be eligible for PR promotion again. This is likely desired behavior, but could cause duplicate promotion notifications if a task bounces between statuses. |
| 8 | `src/mainview/hooks/useAvailableApps.ts` | 5-minute TTL on cached apps list | After 5 minutes, the next render triggers a fresh `getAvailableApps()` RPC. Brief flash of empty list is possible if the component re-renders during fetch. Unlikely to be noticeable. |
| 9 | `src/mainview/analytics.ts` | Added `destroyAnalytics()` export; `initAnalytics()` already cleared interval before this PR | None unless someone calls `destroyAnalytics()` and forgets to re-init. Currently nothing calls it in production (only tests). |
| 10 | `src/bun/git.ts` | `removeFetchCache(projectPath)` called from `removeProject` handler | If a project is deleted and immediately re-added with the same path, the next `fetchOrigin()` will run immediately instead of being throttled. Correct behavior. |
| 11 | `src/bun/git.ts:623-630` | `git log -p --max-count=500` in `isContentMergedInto()` | **Reduced accuracy for repos with 500+ commits between merge-base and HEAD.** If a branch has thousands of commits, patch-id comparison may miss older ones. In practice, branches with 500+ commits are unusual for the task-based workflow this app manages. |
| 12 | `src/bun/git.ts:saveDiffSnapshot()` | Pre-check via `git diff --shortstat` before full diff | Heuristic: estimates 80 bytes per changed line. Very long lines (minified JS, base64) could underestimate. The final `Buffer.byteLength` check remains as a fallback, so worst case is one extra full diff buffer that gets discarded. Also: `--shortstat` adds one extra git spawn per snapshot cycle. |

### PR #296 — Minor fixes (Tier 3)

| # | File | Change | Potential Side Effect |
|---|---|---|---|
| 13 | `src/mainview/components/KanbanBoard.tsx` | `tipMountedRef` + `tipTimerRef` for tip rotation | None. Standard React pattern. Tip rotation stops cleanly on unmount. |
| 14 | `src/mainview/components/TaskTerminal.tsx` | `cancelled` flag in async IIFE | If component remounts quickly (same taskId), the old effect's cancelled flag prevents stale setState. The new effect runs fresh. Correct. |
| 15 | `src/mainview/hooks/useImagePaste.ts` | `mountedRef` check before setState | None. Prevents React warning on unmount during paste. |
| 16 | `src/cli/socket-client.ts` | `socket.destroy()` in error handler | Socket is now destroyed immediately on error instead of waiting for 30s timeout. The reject still fires. If any code was relying on the socket being alive after the error event (unlikely), it would break. |
| 17 | `src/bun/git.ts:getUncommittedChanges()` | Single file read instead of two (slice + text) | Binary detection now uses `charCodeAt(i) === 0` on a string instead of checking raw bytes in a Uint8Array. For null byte detection this is equivalent, but `charCodeAt` operates on UTF-16 code units, not raw bytes. Edge case: a file starting with a UTF-8 BOM or multi-byte sequence won't confuse null detection, but a file that is binary-but-valid-UTF-16 with no null bytes could theoretically be misclassified. Extremely unlikely in practice. |
| 18 | `src/mainview/components/GlobalSettings.tsx` | `resetTimerRef` + cleanup | None. Standard pattern. |
| 19 | `src/bun/rpc-handlers.ts:monitorGitPane()` | Refactored to use `cleanup()` helper with try-catch | If `spawn()` inside the interval throws synchronously (not just async rejection), the catch block now calls cleanup and stops monitoring. Previously the interval would keep running despite errors. This is better behavior. |
| 20 | `src/bun/rpc-handlers.ts` | **REVERTED** — TTL-based eviction for pane ID Maps was removed. Panes can live for days; only task close (`cleanupTaskState`) should clean them up. | None (revert to original behavior). |

### Follow-up correction (this commit)

| Change | Why |
|---|---|
| Removed `setWithTtl` / `deleteWithTtl` / `paneIdTtlTimers` / `PANE_TTL_MS` entirely | Pane IDs (devViewer, fileBrowser, gitOp) must persist for the lifetime of the task session, which can be days or weeks. TTL-based eviction was incorrect — it would silently drop pane IDs after 30 minutes, breaking `killDevServerViewerPane()` and other cleanup functions. |
| tmux spawn: `await .exited` → `.exited.catch(() => {})` | Awaiting tmux `select-pane` and `set-option` unnecessarily blocked the RPC handler. These are instant, cosmetic commands. Fire-and-forget with `.catch()` prevents unhandled rejections without blocking. |
