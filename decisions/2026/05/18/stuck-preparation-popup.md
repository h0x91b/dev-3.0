# 051 — Stuck task-preparation popup

## Context

On macOS, the system silently revokes file access for `git`/`tmux` child processes spawned by dev-3.0 (TCC change, usually after an OS update or security-agent activity). Symptom from the user side: a new task hangs forever on `PREPARING… Fetching origin`. The user has no way to tell whether it's the network, their VPN, git auth, or this OS bug. We documented the manual workaround in `README.md` (grant Full Disk Access), but the app itself stayed silent — every affected user had to ask in Slack.

## Decision

Detect the hang client-side and surface a modal with a short triage + two action buttons.

- Backend adds `preparingStartedAt: string | null` to `Task` (`src/shared/types.ts`), written when prep starts (`src/bun/rpc-handlers/task-lifecycle.ts` lines ~819–826 / ~917–924) and cleared in `clearPreparingState()` and `preparingResetUpdates()`. Persistent so an app relaunch mid-prep still has accurate elapsed time.
- Threshold: `STUCK_PREPARATION_FETCH_THRESHOLD_MS = 3 * 60 * 1000`. Exported from `src/shared/types.ts` for reuse by tests.
- `StuckPreparationModal` (`src/mainview/components/StuckPreparationModal.tsx`) is mounted once in `App.tsx`. It re-evaluates every 15 s, picks the task with the oldest `preparingStartedAt` that is still on stage `fetching-origin`, and renders a portal-based modal.
- Dismissal is in-memory only (per-app-session). Persistence would be over-engineering — if the user dismisses and the prep eventually completes, there's nothing to suppress next time.
- macOS-only "Open Full Disk Access settings" button (`navigator.platform.toLowerCase().includes("mac")`) → new RPC `openSystemSettings({ pane: "fullDiskAccess" })` → `Utils.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")`.
- Cross-platform "Open troubleshooting guide" button → `window.open(README_ANCHOR_URL, "_blank")` (Electrobun intercepts and hands to the OS browser via `Utils.openExternal`, see `src/bun/index.ts:492`).

## Risks

- **Renderer-only awareness**: the modal only fires when the project containing the stuck task is the *current* one in the renderer (we walk `state.currentProjectTasks`). If the user is on the Dashboard while a clone hangs, no modal. Acceptable: the user almost always opens the project they just created a task in.
- **Threshold tuning**: 3 minutes is a guess based on one report. Too short → false positives on slow legitimate clones (huge repos, slow networks). Too long → user gives up before the modal helps. Constant is exported, easy to revise.
- **Stage-bound to `fetching-origin`**: stalls on `cloning-shared-paths` (CoW misconfig) or `applying-sparse-checkout` won't trigger this. Different diagnostic; out of scope here.

## Alternatives considered

- **Backend-driven timeout** that hard-cancels the prep after 3 min and pushes a "failed" toast. Rejected — too aggressive; the clone might still complete on a slow link, and forcing cancel removes user agency.
- **Show the popup inline in the TaskCard prep overlay** (instead of a full-screen modal). Rejected — the inline overlay is ~250 px wide; not enough space for triage text, and the user has to be looking at that exact card. A modal interrupts wherever they are in the project view.
- **Persist dismissals in localStorage**. Rejected — adds state to debug, and the modal naturally stops appearing once `preparing` flips to false.
- **No `preparingStartedAt` on Task; client tracks first-observed-at**. Rejected — re-mounting the renderer (app relaunch, project switch) would reset the timer and miss already-stuck tasks.

## Files

- `src/shared/types.ts` (Task field, threshold constant, RPC schema)
- `src/bun/data.ts` (`addTask` extras)
- `src/bun/rpc-handlers/task-lifecycle.ts` (set / clear)
- `src/bun/rpc-handlers/app-handlers.ts` (`openSystemSettings` handler)
- `src/mainview/components/StuckPreparationModal.tsx`
- `src/mainview/App.tsx` (mount)
- `src/mainview/i18n/translations/{en,ru,es}/common.ts` (modal copy)
- `src/mainview/i18n/translations/{en,ru,es}/tips.ts` + `src/mainview/tips.ts` (one tip)
- `src/mainview/components/__tests__/StuckPreparationModal.test.tsx` (12 tests)
