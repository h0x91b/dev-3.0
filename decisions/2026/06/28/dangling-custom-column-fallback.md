# 083 — Dangling customColumnId: render fallback + load-time self-heal

## Context

A task whose `customColumnId` pointed to a custom column that no longer exists
rendered in **no** column and silently disappeared from the Kanban board while
still living in `tasks.json`. Dangling state is reachable two ways: the
`deleteCustomColumn` snapshot race (a concurrent `moveTaskToCustomColumn` stamps
the id after the cleanup snapshot), and multi-instance writes (the shared
`~/.dev3.0/` is edited by another app version / the CLI with a stale project).

## Decision

Two defensive layers:

1. **Render fallback (mandatory).** `KanbanBoard.tsx` now classifies a task as
   "in a custom column" only if that column still exists
   (`isInCustomColumn`). A dangling task falls into `tasksByStatus` and renders
   in its underlying status column. `aiReviewHasItems` uses the same predicate
   so a dangling review-by-ai task can't be hidden by the AI-review toggle.
2. **Load-time self-heal.** `rawLoadTasks` (`src/bun/data.ts`) clears a dangling
   `customColumnId` to `null` — an in-place content rewrite mirroring the legacy
   `say` cleanup migration. It persists **only on mutator reads**
   (`persistMigrations`, which run under the file lock and bypass the cache), so
   pure reads never cache a transformed value. Guarded on
   `Array.isArray(project.customColumns)` so a partial project object can't wipe
   valid assignments.

## Risks

- The multi-instance race can't be fully eliminated; the render fallback is the
  permanent safety net, so this is acceptable. Worst residual case (a column
  re-added by another instance with an identical id while a heal is cached) only
  misplaces a task into its status column — never hides it — and self-corrects.
- `customColumnId` stays `string | null` with unchanged meaning. `null` is the
  value old versions already produce via the `rawLoadTasks` backfill, so files
  written by the fixed version stay loadable after a downgrade.

## Alternatives considered

- **Lock the whole `deleteCustomColumn` operation** to close the race at the
  source — rejected as insufficient on its own (doesn't touch the multi-instance
  path) and unnecessary once the two layers make dangling state benign.
- **Heal on every read (incl. pure reads) + cache the healed value** — rejected:
  it caches a value derived from a *separate* entity (`project.customColumns`)
  that can change without the tasks file changing, introducing a (benign but
  avoidable) stale-cache window. Gating the heal behind `persistMigrations`
  sidesteps it entirely.
