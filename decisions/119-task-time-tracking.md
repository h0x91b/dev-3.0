# 119 — Task time tracking (total / agent / focus)

## Context

The Productivity cockpit celebrates *how much* you ship (tasks, lines) but not *how
long* it took. We wanted three durations per task, surfaced globally and per project:
total lifetime, agent time (coding + AI review), and "your time" — the human's real
attention. The manifest (§1.1) mandates instrumenting countable signals into the stats
pipeline at build time, so time is emitted into `ProductivityStatEvent` even where a
viz isn't drawn yet.

## Decision

Two independent mechanisms feed three metrics:

1. **Status wall-clock** (total + agent). Every status transition flows through
   `applyTaskUpdate` (`src/bun/data.ts`) — the single choke point. On a status change we
   finalize the leaving status's duration into `Task.statusDurations` (per-status ms) and
   re-stamp `Task.statusEnteredAt` (`accumulateStatusDuration`). Custom-column-only moves
   keep the same status, so they don't finalize a bucket (gated on `statusChanged`, not
   `renderedColumnChanged`). Total time is `createdAt → movedAt` (terminal) — always
   available, even for legacy tasks. Agent time = wall-clock in `AGENT_TIME_STATUSES`
   (`in-progress` + `review-by-ai`); "user wall-clock" in `USER_TIME_STATUSES` is a
   secondary fallback. Pure decomposition lives in `computeTaskTimeBreakdown`
   (`src/shared/types.ts`), which credits the live portion of the *current* status for
   active tasks (never the sit-time of a terminal status).

2. **Real UI attention time** (focus / "your time"). The user asked for genuine focus
   time, not status wall-clock. `src/bun/focus-tracker.ts` samples every 15s: it credits
   the interval to the on-screen task only when the app window is foregrounded
   (`isAppForeground`), a task is the active context (`getActiveContext`), and the user
   isn't idle past 60s (`getUserIdleSeconds`, macOS HID). It buffers in memory and flushes
   to `Task.focusMs` via `addTaskFocusMs` (a minimal writer that does NOT bump
   `updatedAt`/`movedAt`/history, so periodic flushes don't spam board re-sorts). The pure
   `shouldCreditFocus` + injectable-deps `FocusTracker` class keep it unit-testable.

Aggregation over the period's completed tasks (total/agent/focus, per-project, avg/task,
`hasTracking`, `trackingSince`) lives in `computeProductivityStats`
(`src/mainview/utils/productivityStats.ts`); the "Time invested" section + per-project
time render in `ProductivityStatsView.tsx`.

## Risks

- **Legacy tasks** have no `statusDurations`/`statusEnteredAt`/`focusMs` — total time still
  shows, but agent/your split reads 0 until they're re-tracked; the UI shows an honest
  "tracking starts now" hint, mirroring the LOC "tracking since" pattern.
- **Remote mode:** `getUserIdleSeconds` reads the *server's* HID, not the browser user's.
  Foreground + active-context still come from the browser renderer, so focus degrades to
  "foreground + on-screen" off the desktop — acceptable, and idle-unknown counts as active.
- **Multiple renderers** (desktop + browser) share one global foreground/active-context
  (last-writer-wins) — an accepted pre-existing design (same as the git-poll throttle).

## Alternatives considered

- **Status-based "your time"** (wall-clock in user-owned statuses) — rejected: a task left
  in "Your Review" overnight would count the whole night as focus. The user explicitly
  chose real UI attention time. Kept as a secondary `userMs` for completeness.
- **Deriving durations from a status-change history log** — heavier; the choke-point
  accumulator is O(1) per transition and needs no replay.
- **A project-scoped stats route** — deferred; per the user's choice we extended the
  existing per-project breakdown cards instead (no new destination).
