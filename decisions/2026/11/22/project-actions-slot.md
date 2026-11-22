# Dashboard project actions from an internal `projectActions` slot

## Context

Inventory item 2.6 of the GUI move to Cordis plugins (coordinator task seq:2526). Each dashboard project shows its actions in two places:
- on wide screens, a resting-visible icon cluster on the row (`ProjectActionButtons`);
- on narrow screens, a kebab that opens a `BottomSheet` (bible §12.3).

The two lists differ on purpose. Open board appears only in the sheet, because on wide the row itself opens the board. `Spaces…` appears only on the row. Move up/down appear only in the sheet. The /ux-principal gate ruled CHANGE: a contribution slot, under constraints (`reports/ux-principal-project-actions.md` in the coordinator's batch).

## Decision

- **One item list, drawn twice.** `src/mainview/project-actions/registry.ts` declares the internal `projectActions` slot. An item is data plus `run`: `glyph`, `label(scope)`, `when(scope)`, `region` (`actions` or `danger`) and `placements` (`row` and/or `sheet`).
  - The host draws every button: the row in `ProjectActionButtons`, the sheet in `ActivityOverview`.
  - `label` sees the placement, so the terminal keeps its two strings, `projectTerminal.tooltip` on the row and `activity.openTerminal` in the sheet.
- **Built-ins** (`project-actions/builtins.tsx`): open-board, spaces, settings, finder, terminal, remove. They carry today's gates: virtual boards have no folder, and the built-in Operations board cannot be removed.
- **Reorder stays host-owned.** Move up/down depend on list and space-write state, so they are not items. The sheet draws them after dev3's actions and before the danger group, where they were before.
- **Danger is pinned last by the host,** whatever its `order`. Only dev3's own items can be danger. Another plugin's item is never styled as danger and never lands after Remove.
- **Extension budget.**
  - Row: no extension item ever rests there; a future `…` overflow owns them.
  - Sheet: at most 5 extension items, after reorder and before Remove.
  - The full rule is an opening-track precondition in `docs/extensions-platform.md`. `docs/ux` is unchanged.
- **Guards.** Resolution goes through `plugins/menu-rows.ts`. A throwing `when`/`label`, or a malformed item (label or glyph not a string), drops only that item and is logged once per id. Every failing `run` is logged.
- **Subscriptions and cold start.** The row subscribes to the slot; the sheet subscribes only while it is open. Until the built-ins register, both draw them directly.
- **Parity.** `components/__tests__/ProjectActionsPin.test.tsx` was committed on main before the move and passes unchanged. It pins the outer HTML of every project's cluster and sheet for: a real project, a virtual board, the Operations board, with and without spaces, reorderable or not, and with no removal.

## Risks

The row cluster re-resolves its items on every render of a row. This is cheap: six items, no RPC, and one snapshot read. The narrow sheet still has no `Spaces…` entry. That gap predates this change and is noted for the user, not fixed here.

## Alternatives considered

- **A replace slot for the whole cluster:** rejected, because one plugin could then hide Remove or Settings for every project.
- **Reorder as items:** rejected, because it couples list mechanics to item order, and an extension could land between the two steps.
- **Extension icons on the resting row, even one:** rejected, because it multiplies across every row of the list.
