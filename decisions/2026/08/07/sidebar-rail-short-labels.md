# The rail's upright word appears only when the rail is tall enough for it

## Context

Concept A of the Active Tasks sidebar study (task seq 1415) ports the Kanban
card's lifecycle rail (`TaskCardRail`, PR #1244) into the 240px sidebar column,
so one vocabulary covers board and sidebar.

## Investigation

Measured on the live sidebar: an upright letter is ~14.4px, and the ring, the ✓
and the rail's padding claim ~58px before the word starts. The rail is
`self-stretch`, so on a short row the word *set* the row height instead of
describing it — 144px with `REVIEW`, 159px with `WORKING`, against a 96px
baseline, leaving dead space under the title. But sidebar rows are not one size:
a row carrying an overview measured 273px, and there the word costs nothing.
Three-letter forms (101px) fixed the height and bought a second status
vocabulary in three locales; dropping the word outright lost it on the tall rows
that had room for it.

## Decision

`TaskCardRail` gained `autoLabel`. The sidebar sets it, the card does not (a card
is always tall enough). With it on, the rail measures itself through a
`ResizeObserver` and renders the upright word only when its height clears
`58 + letters * 14.4`. Showing the word only when it already fits cannot grow the
rail, so the measurement settles in one pass with no oscillation. Verified live:
88px rows show ring + ✓ only, `PR` appears at 104px, `ON HOLD` at 273px.

## Risks

A row can gain or lose its word as its content changes (an overview arriving
makes the word appear). Accepted: it moves with the row's own height, and the
status is never lost — the full name stays in the rail button's `aria-label` and
tooltip. `ResizeObserver` is absent in happy-dom, so tests see the word hidden;
the guard treats a missing observer as "no label".

## Alternatives considered

Three-letter forms plus a 4-char custom-column clip (101px rows, eight extra
i18n keys per locale, two words for one status). A colour-only rail with no ring
and no word (71-88px rows, and it threw away the word on rows that had room).
Dropping the ✓ instead of the label (saves 28px, costs the sidebar its only
action).
