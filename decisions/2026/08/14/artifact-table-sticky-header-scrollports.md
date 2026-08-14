# Sticky artifact table headers depend on which box is the scrollport

## Context

The artifact starter's tables gained a header that stays visible while rows scroll
(`src/assets/artifact-template/app.css`, `thead th`). `position: sticky` resolves its
offset against the nearest scrollport, which made two existing rules silently hostile.

## Investigation

1. `.table-card` used `overflow: hidden` to clip the table to the card radius. That makes
   the card a scroll container, so the header pinned to the card — which never scrolls —
   and never moved. `overflow: clip` clips identically without creating a scrollport.
2. `.evidence-table-scroll` sets `overflow-x: auto`, so its block axis computes to `auto`
   too and it *is* a scrollport. With the page offset applied, the evidence header rendered
   56px down inside the ledger, painted over the first rows. Verified in headless Chromium
   before and after the fix.

## Decision

`.table-card` uses `overflow: clip`. The page offset lives in `--dev3-table-head-top`, set
by `trackStickyOffset()` in `app.js` from the measured `.section-nav` height (0 when a
report has no nav), and `.evidence-table thead th` resets it to `top: 0`. Print resets
`position: static` so `thead` repeats per page instead of pinning.

## Risks

`overflow: clip` needs Chromium/Safari 16+; older engines lose corner clipping but keep the
layout. A report that hand-builds its own sticky chrome above the nav can overlap the header —
it must feed its own height into `--dev3-table-head-top`.

## Alternatives considered

Hard-coding `top: 56px` (breaks reports without a nav, and any nav that wraps);
`JavaScript`-driven header cloning (heavier, breaks print and text selection);
leaving headers unpinned (the original problem — a 200-row ledger loses its column names).
