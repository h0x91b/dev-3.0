# 124 — Active Tasks sidebar: readiness tiers + visible priority

## Context

The Active Tasks sidebar is the user's live work queue. Priority (P0–P4, shipped in #893)
sorted the list under the hood but was **invisible** there — no badge, so the order looked
arbitrary. The list also grouped by raw status, which mixed "waiting on me" tasks with
background agent churn, and the bell/attention scope sorted purely by age, inconsistent with
the rest of the app. Scope was the sidebar only; the kanban already surfaces priority well.

## Decision

Group the sidebar by **readiness tier** instead of status, and make priority visible.

- Three tiers, top→bottom: **NEEDS YOU** (`review-by-user` ∪ `user-questions` ∪
  `review-by-colleague` *with a live bell signal*) → **custom columns** (one block each, in
  project column order) → **WAITING** (`in-progress` ∪ `review-by-ai` ∪ unsignalled
  `review-by-colleague`). Empty tiers are hidden; built-in tiers get a counted sticky header.
- Within every tier: priority band P0→P4, then oldest `movedAt`, then `seq`.
- The signal-driven `review-by-colleague` placement (`bellCounts.get(id) > 0`) is the one
  tier that depends on runtime signal, not status alone.
- Each card shows the kanban's `PriorityBadge` (first in the top row, always incl. P3; picker
  → group-wide `setTaskPriority`) + a compact per-card status label. The attention/bell scope
  is the NEEDS YOU tier at global breadth with the same priority-first sort.
- Grouping + ordering is a pure, unit-tested function: `src/mainview/components/sidebarTiers.ts`
  (`groupTasksIntoTiers`, `byPriorityThenMovedAtOldestFirst`). Rendering/i18n/colors stay in
  `ActiveTasksSidebar.tsx`. The kanban, priority model/storage, and `PriorityBadge` are untouched.

## Risks

- The sidebar card became a `<div role="button">` (was a native `<button>`) so the nested
  `PriorityBadge` button is valid HTML; keyboard activation (Enter/Space) is restored manually.
- Per-task attention bells (`dev3 attention`) stay purely visual — they never move a task
  between tiers or reorder it; only a `review-by-colleague` bell (a PR signal) promotes a tier.
- Tier-header color reuses status hues as zone cues (`user-questions` warm for NEEDS YOU,
  `review-by-ai` grey for WAITING) — no new tokens; the per-card rail keeps the true status hue.

## Alternatives considered

- **Keep per-status groups, just add the badge.** Rejected: priority already sorted within
  status groups but the user still couldn't tell actionable work from background churn.
- **Let a per-task attention bell promote any task.** Rejected: `dev3 attention` is an
  agent-raised visual nudge, not a readiness signal; only a PR CI/review bell changes tier.

Supersedes the 2026-06-22 "oldest-first, uniform across groups" rule (UX_DECISIONS.md).
