# Table view: elastic columns with caps, not a title that eats the row

## Context

The Table board view sized the Title column as `minmax(14rem, 1fr)`, so it took every spare pixel. On a 3072px viewport Title measured 2136px while Labels stayed clamped at 14rem and clipped its chips at three labels. A task's status and labels ended up two thousand pixels from the title they describe — reported from an ultrawide monitor.

## Investigation

Measured in headless Chromium on a scoped QA board at 3072 / 1920 / 1440 / 1100 / 1024px, with the default eight columns and with all thirteen. One grid detail drove the design: a grid's max-content width (what `min-w-max` on the table resolves to) sizes every `minmax(Nrem, Mfr)` track from the single largest floor-to-factor ratio. Two tracks with different ratios therefore make the narrowest table wider than the sum of its floors (`224px + 128px` measured as `256px + 128px`), and horizontal scroll starts early.

## Decision

`tableGrid()` in `src/mainview/board-views/table/table-model.ts` owns the row grid. A column is either fixed or elastic `{ min, max }`; an elastic track is `minmax(<min>rem, <max>fr)`, so spare room is shared in proportion to the caps. The `role="table"` element in `TableView.tsx` gets a `max-width` equal to the fixed widths plus the caps plus gaps and padding, which is exactly the width where every elastic track equals its cap. The cap follows the shown columns, and the table stays start-aligned under the board toolbar. Column gap and row padding moved out of Tailwind classes into the same function so the cap cannot drift from them. All elastic columns keep one floor-to-cap ratio (0.35); a test asserts it.

## Risks

The caps are judgment values: Title 40rem fits an 80-character title, Labels 20rem fits four chips. A board with longer titles truncates on a screen that has room. Beyond the cap the area to the right of the table is empty.

## Alternatives considered

- One fixed `max-width` for the table: cannot be right for both four columns and thirteen.
- Centering the capped table: breaks the leading edge it shares with the toolbar above it.
- Full-width rows with the columns packed to the start: zebra and hover would cover an empty, clickable void.
- Widths computed in JS from a `ResizeObserver`: allows staged growth, costs a render per resize for no visible gain.
- Showing more columns automatically on wide screens: overrides the columns the user picked.
