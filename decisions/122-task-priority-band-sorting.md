# 122 — Task priority (P0–P4): strict bands over manual order, drag-as-re-prioritization

## Context

The board treated every task as equally important; the only ways to surface an urgent task were fragile manual drag-ordering (per-column, invisible as data) or abusing labels (no ordering semantics). We added a five-level priority (`P0` highest … `P4` lowest, default `P2`) that the board and active-tasks sidebar sort by. Two design choices were non-obvious and are recorded here.

## Decision

1. **Priority is a strict, topmost sort band — it beats manual order.** `comparePriority` is the first key in `sortTasksForColumn` (renderer, `src/mainview/components/sortTasks.ts`) and in the data-layer column reconstruction (`sortColumnTasksForReorder` in `src/bun/data.ts`). Every existing within-band rule (in-session move order, persisted `columnOrder`, variant grouping, `movedAt`/`createdAt`) applies unchanged *inside* a band. The mental model is unconditional: "a column is always sorted by importance, ties broken by the old rules." A whole variant group shares one priority (`setTaskPriority` writes every member), so banding never splits a group.

2. **Dragging a card across a band re-prioritizes it (Linear-style), resolved by the neighbor BELOW the drop slot.** In `reorderTasksInColumn`, after removing the moving group we read the landing band from `remaining[clampedIndex]` (the card the item lands on top of / pushes down), falling back to the card above only at the very bottom. So "drag to the top of a band's visual region" keeps that band (the gap above the first P2 belongs to P2), "drag to the very top" adopts the top band, and "drag among/into a higher band" promotes. A same-band drop is a pure reorder and never mutates priority. The whole group adopts the new band.

Storage: `priority` is stored explicitly on every task; a load-time in-place content migration in `rawLoadTasks` stamps `P2` onto tasks lacking the field (path untouched — complies with the frozen `~/.dev3.0/` layout; older app versions ignore the unknown field). New tasks are created with `P2`.

## Risks

- The neighbor-below boundary rule is a heuristic; with no visual band separators (deliberately out of scope) a user dropping exactly at a band boundary might expect the other band. Mitigation: the rule is deterministic and documented; drag-to-top / drag-to-bottom (the common promote/demote gestures) behave intuitively.
- Strict bands override a user's manual within-column position across bands — a card dropped into a foreign band changes its priority rather than staying put. This was an explicit, accepted user decision (the "always sorted by importance" model).

## Alternatives considered

- **Manual order wins, priority is only a tiebreak** — rejected: importance would still drown under manual drags, defeating the point.
- **Absence-means-P2 (no stored field)** — rejected by the user in favor of explicit storage; the load migration is the sanctioned in-place content-rewrite pattern (same as the `say` cleanup migration).
- **Neighbor-ABOVE boundary rule** — rejected: it promoted a card to the higher band whenever the user dropped it at the top of a lower band, making same-band top-of-band reordering impossible without an accidental promotion.
