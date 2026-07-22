# 153 — Artifact SVG and print contract

## Context

The artifact starter demonstrated only an area chart and a CSS-background donut. Browser printing dropped the selected dark theme and the donut itself, producing a pale, awkwardly split PDF even when the on-screen report was dark.

## Investigation

Print engines may omit CSS backgrounds unless the document requests exact color adjustment, and CSS conic gradients are especially fragile in that mode. Inline SVG stays self-contained under the artifact CSP, remains crisp at PDF scale, and exposes chart structure to assistive technology through titles and descriptions.

## Decision

The v1 starter uses inline SVG for its area, pie, and radar charts, with every series colored by the existing `--dev3-*` semantic tokens. Its print stylesheet uses exact color adjustment, preserves the active light/dark token set, hides interactive controls, compacts the chart grid, and protects cards, table headers, and rows from accidental page breaks.

## Risks

Dark-theme printing intentionally consumes more ink because the exported PDF must match the user's selected theme. Browser print engines can still paginate differently at unusual paper sizes, so the layout uses flexible grids and break hints rather than assuming one fixed page format.

## Alternatives considered

Rejected an external charting library because artifacts must work offline without network dependencies. Rejected canvas and CSS-gradient charts because they print less reliably, and rejected a forced white print theme because it contradicts the explicit theme choice.
