# Variant priority is per task, not per group

## Context

Since `decisions/2026/07/10/task-priority-band-sorting.md` every priority write (`data.setTaskPriority`)
went to the whole variant group, including completed and cancelled siblings. Users rank the variant
they prefer with priority, so changing one variant silently re-ranked all of them and the mark meant
nothing. No surface told the user the write spread.

## Investigation

The group-wide write existed so a variant group, then kept adjacent in its column, never split across
sort bands. `decisions/2026/08/11/derive-in-column-task-order.md` removed that adjacency: every task now
sorts on its own. Nothing else reads sibling priority as shared (`compareTasksInBand`, `sidebarTiers.ts`,
`dev3 tasks list` all read each record).

## Decision

`setTaskPriority` (`src/bun/data.ts`) writes the target task only. Every UI surface and
`dev3 task update --priority` inherit that through the one setter. By the user's ruling there is no
group-wide option, checkbox, confirmation or CLI flag. New variants and attempts still start at the
source task's priority (`spawnVariants`, `addAttempts`); after that each changes independently.
`setTaskHidden` stays group-wide — visibility is a different property and was not raised.

## Risks

- No migration: groups that are uniform today stay uniform until one variant changes.
- An older app build still writes priority group-wide, so a change made there re-unifies the group.
  The field and path are unchanged, so older builds read diverged values correctly.
- Re-ranking a whole task now takes one change per variant.

## Alternatives considered

- A confirmation after each change (this variant / all variants): a question on every mark whose answer
  is almost always "this one".
- Per-variant default plus an explicit "Apply to all N variants" item: rejected by the user — no extra controls.
- A separate preferred-variant marker: a new concept, out of scope.
