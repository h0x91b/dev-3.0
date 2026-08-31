# Artifact tables: the query container goes on the table's own parent

## Context

An artifact's 6-column table inside a half-width `.card` rendered as a real table
at 446px, wrapped mid-number, spilled past the card, and pushed a horizontal
scrollbar onto the page. `AUTHORING.md` promises the opposite in bold — "No table
scrolls sideways, and you write nothing to get that" — and the shell's JS half of
that promise (copying `thead` headings onto every cell) already ran for every
table on the page.

## Investigation

Measured in headless Chromium: no ancestor of the table had `container-type`, so
`@container dev3-table (max-width: 768px)` evaluated to false and the stacking
never applied. A container query with no matching container never matches and
never warns — the failure is silent. The declaration was opt-in
(`.table-card, .evidence-table-scroll`), while the docs and the JS were universal.

Second defect found in the same pass: the relabel observer only fired when the
mutation *target* was inside a table (`record.target.closest("table")`). Report
code writes the whole table into a host `div` in one assignment, so the target is
that div and the labels were never written — the stacked rows came out as bare
values with no column names.

## Decision

`src/assets/artifact-template/app.css` declares the container on the table's own
parent — `:not(html, body):has(> table)` — alongside the two existing classes, and
the print block drops it on the same selector so paper keeps real columns.
`src/assets/artifact-template/app.js` gains `recordTouchesTable`, which also
inspects `addedNodes` for a table. Verified in Chromium: the table stacks with
labels, wrapper/card/grid overflow goes to zero, the wide demo table stays
tabular, and the printed PDF keeps real columns.

## Risks

`container-type: inline-size` on the table's parent makes that box a containing
block for fixed-position descendants and contains its inline size. The shell's
own panels live in the browser top layer, so nothing there is affected, and the
inline containment is desirable: a wide table can no longer stretch its card.
`:has()` on an unqualified subject is a wide selector; on an artifact page (one
document, no framework re-renders) the cost is not measurable.

## Alternatives considered

Declaring the container on `.card:has(table)` — bigger blast radius and it
measures the padded card rather than the box the table actually sits in.
Rewriting the docs to require `.table-card` instead — makes every author opt in
to the one behaviour the shell exists to guarantee, and the JS would stay
universal while the CSS was not.
