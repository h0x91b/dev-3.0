# Table view: compact columns, and the spare room shows the overview

## Context

The Table board view sized the Title column as `minmax(14rem, 1fr)`, so it took every spare pixel. On a 3072px viewport Title measured 2136px while Labels stayed clamped at 14rem and clipped its chips at three labels: a task's status and labels sat two thousand pixels from its title. A first fix capped the table's width and left it start-aligned. It read as a layout bug — the header band and the zebra stopped mid-screen, the view's own options button ended up 1370px away from the table, and half the screen stayed empty.

## Investigation

Measured in headless Chromium on a scoped QA board at 3072 / 2560 / 1920 / 1760 / 1440 / 1100 / 1024px, with the default eight columns and with all twelve a project board offers, in both themes. The grid behaviour the design rests on, confirmed by those measurements: tracks with a fixed maximum (`minmax(14rem, 36rem)`) are grown to their caps **before** a flexible track receives anything, in equal increments. So one trailing `minmax(0, 1fr)` track collects exactly the room the columns cannot use.

## Decision

`tableGrid()` in `src/mainview/board-views/table/table-model.ts` builds the row grid: fixed columns, elastic columns with a floor and a cap (Title 14–36rem, Labels and Branch 8–16rem), then one trailing spare-room track. The table spans the board's full width again; its `min-width` is the sum of the floors, set explicitly because `min-width: max-content` would resolve to the sum of the caps. `OverviewCell` in `TableCells.tsx` fills the spare room with `getTaskOverview(task)` rendered through `TaskRefText`, so `<seq:N>` and `<pr:N>` stay links. A container query on the cell (`SPARE_CELL` / `SPARE_TEXT` in `TableView.tsx`) hides the text until the cell is 12rem wide. The overview is not a toggleable column: it is what the table does with room nothing else needs, which also means stored layouts need no migration. End-aligned columns carry `pe-3`, since a start-aligned column now always follows them.

## Risks

The caps are judgment values: 36rem fits an 80-character title, 16rem fits four label chips. Equal-increment growth gives Title only its share while Labels and Branch are still growing, so with every column shown at 1920px Title is 340px. The overview cannot be switched off. In the light theme the page gradient darkens toward the bottom-right, where `text-fg-2` on a zebra row measures about 4.0:1 — the same pair every other end-of-row cell already had.

## Alternatives considered

- Capping the table's width, start-aligned or centred: no cut-off look when centred, but the room stays empty and the toolbar above no longer shares an edge with it.
- Overview inline after the title, mail-client style: fills the Title column, but status and labels stay far from the title.
- Overview as a regular toggleable column: needs a sort that means nothing, and every stored layout would lack it, hiding the feature from exactly the people who use the Table.
- Proportional `fr` growth for the elastic columns: favours Title at mid widths, but cannot be capped without a second layout mechanism around the grid.
- Widths computed in JS from a `ResizeObserver`: full control over staged growth, at the cost of a render per resize.
