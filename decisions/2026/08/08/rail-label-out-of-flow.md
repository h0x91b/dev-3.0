# The rail's upright word is painted out of flow, so it cannot measure itself

## Context

`decisions/2026/08/07/sidebar-rail-short-labels.md` gave `TaskCardRail` an
`autoLabel` mode: the sidebar rail measures its own height through a
`ResizeObserver` and prints the upright status word only above
`58 + letters * 14.4`. It claimed "showing the word only when it already fits
cannot grow the rail". That claim is wrong.

## Investigation

The rail is `self-stretch` in a row whose height comes from its own content, so
the rail's intrinsic height competes with the content column. `WORKING` in flow
needs ~159px against an 88px baseline row — so the word that had just been shown
on a 257px row (task focused, overview rendered) became the tallest thing in the
row the moment the overview left. The measurement then read its own word's
height, stayed above the threshold, and the row never shrank: reported live as
short sidebar rows stuck at ~257px with a word and empty space under the title.

## Decision

With `autoLabel` on, the word renders inside a `relative flex min-h-0 w-full
flex-1 overflow-hidden` slot as an `absolute` child (`TaskCardRail.tsx`), so it
contributes nothing to the rail's intrinsic height and the observed height only
ever describes the row's real content. The card path (no `autoLabel`) keeps the
word in flow — a card is always tall enough, and clipping it there would be a
regression. Verified live in the browser: switching the focused task from a row
with an overview drops it from 257px + `WORKING` back to 88px with no word.

## Risks

The word is now clipped rather than height-forcing if a row is somehow shorter
than the threshold predicts — acceptable, the full status stays in the rail
button's `aria-label` and tooltip. `ResizeObserver` is still absent in happy-dom,
so tests must inject one (`__tests__/TaskCardRail.test.tsx`).

## Alternatives considered

Measure a sibling outside the rail (the row's content column) — needs a ref
threaded from `ActiveTaskRow` into `TaskCardRail` and couples the two. Cap the
row height in CSS — hides the symptom, leaves the word deciding its own fate.
Drop the word from the sidebar entirely — already rejected in the 2026-08-07
record.
