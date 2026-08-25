# Artifact `.dashboard-grid` defaults to a full row

## Context

`.dashboard-grid` in the artifact starter (`src/assets/artifact-template/app.css`) is a 12-column grid, and only the starter's own demo panels (`.velocity-panel`, `.pie-panel`, `.radar-panel`, `.scenario-panel`) carried a `grid-column: span N`. An author writing their own panel — the normal case, since the demo panels get deleted — got a child with no span, which CSS grid places in exactly one column. On a 1150px-wide artifact pane that is an 86px column: every word on its own line, long tokens clipped by the card.

## Investigation

Reproduced from a real shipped artifact (`24-hour GitHub triage`, `shared-artifacts/b36abdb6…`), whose `#findings` section is a bare `<section class="dashboard-grid">` with two `<article class="card section">` children. In headless Chromium the computed grid was twelve 85.5px tracks and both panels measured 86px wide. With the fix they measure the full row; adding `span-6` gives 544px each at 1150px, and below 901px they go full width with zero horizontal overflow.

## Decision

`.dashboard-grid > *` now sets `grid-column: 1 / -1`, and opt-in widths `.span-3` … `.span-9` live inside `@media (min-width: 901px)`. `1 / -1`, not `span 12`, because the same grid drops to one column below 900px and to two columns in print — a `span 12` default would create implicit columns and overflow there. The widths sit inside the media query rather than being reset in the narrow one so their higher specificity cannot leak into the collapsed layouts. Documented in `AUTHORING.md`; guarded by `src/bun/__tests__/artifact-template.test.ts`.

## Risks

An author who wants two panels side by side must now add a class; without one they get a readable full-width stack instead of a dense row. Existing artifacts already published are unaffected — they carry their own copy of `app.css`.

## Alternatives considered

Turning the grid into `repeat(auto-fit, minmax(…, 1fr))` would size panels automatically but breaks the 8/4 and 7/5 asymmetric layouts the starter demonstrates. Defaulting to `span 6` keeps density but leaves a lone panel half-width next to dead space, which is the same "looks broken" report in a milder form.
