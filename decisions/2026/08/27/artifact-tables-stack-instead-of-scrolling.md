# Artifact tables stack instead of scrolling

## Context

Tables in the dev3 HTML artifact starter (`src/assets/artifact-template/`) were unreadable on a narrow
screen in two different ways. Dense ledgers wrapped in `.evidence-table-scroll` scrolled horizontally
(`overflow-x: auto` over a `width: max-content` table), and plain tables in `.table-card` were worse: the
card's `overflow: clip` meant columns past the edge were not scrollable but simply *gone*, while a
`@media (max-width: 560px)` rule additionally hid the third and fifth columns outright. Measured at 375px,
the 7-column run table clipped to 345px of a needed 512px and the 12-column ledger to 296px of 1094px.

## Investigation

A headless-Chromium pass over a probe artifact (7-column table with a long-text column, 12-column
evidence ledger) counted elements whose `scrollWidth` exceeded their `clientWidth`: two offenders at 768px
and two at 375px before the change, zero at 1440/768/375px after. The in-app viewer was cleared as a
suspect by reading it — `TaskArtifactViewer.tsx` renders a bare `h-full w-full` iframe with no width
constraint or scroll container of its own, so the artifact's own CSS owned the whole bug.

## Decision

The stacking threshold is **768px, matched against the table's own container**, not the viewport
(`container: dev3-table / inline-size` on `.table-card` and `.evidence-table-scroll`, queried by
`@container dev3-table (max-width: 768px)` in `app.css`). 768 is the same narrow gate the app uses
(`PRODUCT_UX_BIBLE.md` §12.1), so "narrow" means one thing across the product. A container query rather
than a media query because a table can be narrow while the page is wide — verified: in a 398px panel at a
1400px viewport the table stacks, which a media query would get wrong. A stacked row is a
`grid` of `repeat(auto-fit, minmax(13rem, 1fr))`, so cells pair up while there is room (3 across at 768px)
and drop to one per line on a phone, with `.wrap` cells spanning the full width.

Cell labels come from the shell, not from authors: `labelTableCells()` in `app.js` copies each
`thead` heading onto the cells beneath it and re-runs from a `MutationObserver` because `report.js`
renders rows after the shell boots. **Authors write nothing new** — a plain `<table>` with a real
`<thead>` is the entire contract, and there is no `data-label` attribute to keep in sync.

A table with very many columns is deliberately *not* capped, truncated, or folded behind a
"show more": its cells are the payload, and hiding some of them is the data-loss bug being removed here.
Such a table simply gets long vertically, which scrolls in the direction phones already scroll.

## Risks

`container-type: inline-size` applies layout and style containment to `.table-card`, which could in
principle clip an absolutely-positioned descendant; the shell's popovers and enhanced selects use the
browser top layer, so they are unaffected, and no console errors or clipping appeared in QA. Paper is
narrow enough to trip the container query, so `@media print` resets both wrappers to `container: normal`
— verified against a rendered PDF, which keeps real columns and a repeating header. The header row is
hidden while stacked, so `data-sort` headings are not clickable on a phone; a report that must stay
sortable there puts a sort `<select>` in `.table-tools`, and `AUTHORING.md` now says so. Existing task
worktrees keep their already-provisioned `artifact-template-v1` copy, so the fix reaches new tasks first.

## Alternatives considered

**Keep the scroller and only restyle it** — rejected: the requirement is no horizontal scrolling at all,
and a scroller hides columns behind a gesture. **A `data-label` attribute per cell** (the classic
pure-CSS stacking pattern) — rejected: it is a permanent tax on every future artifact author and drifts
out of sync with the headings the moment a column is renamed. **Label above value in every cell** —
rejected as unnecessarily tall once `auto-fit` proved it could pair cells up without any per-cell markup.
**A viewport media query at 560px** (reusing the existing breakpoint) — rejected: it lies for a table in a
narrow panel, and 560 would leave a 6-column table squeezed between 560 and 768px.
