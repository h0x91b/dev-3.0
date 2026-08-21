# Space reorder: drag in the rail, stepwise in the header overflow

## Context

The previous commit made the rail the one surface that reorders spaces, with two
visible paths: drag a row, or toggle a **Reorder** mode beside the `Spaces`
label that turned every row into a name plus ↑/↓. The mode existed because HTML5
drag has no touch and no keyboard equivalent.

Reviewed on screen, the mode read as redundant chrome: the resting grip already
says "this row drags", so the toggle was a second visible control for a gesture
the user could already see, inside a 224px column that has no width to spare.

## Investigation

Where the width goes in a 224px rail row: 20px padding leaves ~204px, the grip
takes 14px + 10px gap, the activity dots and count take ~40px. Two 32px step
buttons cannot be added without dropping the name to ~60px — which is why the
mode dropped the counts to fit them, i.e. it changed what a row means for the
duration.

Project rows have the same problem one level up: a row carrying task rows and
the board footer is ~300px tall, so five of them are ~1500px. The drop target
during a reorder was routinely off screen, with the pointer held down.

## Decision

- **Rail:** drag only, advertised by the resting grip (`SpacesRail.tsx` —
  `dragHandlers`, `GRIP_GLYPH`). No mode, no per-row arrows.
- **Stepwise path:** `Move up` / `Move down` in the space header's existing `…`
  menu (`SpaceHeaderMenu.tsx` → `onMove`; the write is `handleMoveSpace` in
  `ActivityOverview.tsx`, over the same `reorderSpaces` RPC). An overflow entry
  costs no resting pixels, and the edges are computed from the full space order,
  not the filtered groups on screen (`spaceOrder` prop).
- **Project drag:** while a drag is in flight, every project row in the same
  reorder scope collapses to grip + name (`compact` in `renderProjectRow`, fed
  by `RowReorderCtx.groupDragActive`). Scoped to the group because only that
  group accepts the drop — compact and droppable stay the same statement.
- `New space` ends the rail's space list instead of `mt-auto`, and the space
  header's `+` / `…` sit against the space name instead of the far right.

## Risks

- Space order is now mouse-only in the rail itself; a user who never opens the
  header `…` will not find the stepwise path. Accepted: the rail is
  `hidden lg:flex`, so the touch case it served was narrow, and the header menu
  is the same object's own chrome.
- Collapsing rows mid-drag reflows the page under the pointer. Chromium keeps
  the drag image from `dragstart` and the source node keeps its identity (the
  collapse is a class/children change on the same tree, never a remount), so
  `dragend` still fires — verified by drag in a browser, not only in tests.

## Alternatives considered

- **Keep the reorder mode.** Rejected by the user as duplicate chrome; the grip
  already advertises the gesture.
- **Delete the mode with no replacement.** Would leave space order with no
  keyboard or touch path at all.
- **`Alt+↑/↓` on a focused rail row.** Zero pixels, but invisible — the manifest
  treats an undiscoverable-only path as an anti-pattern.
- **A kebab menu on each rail row.** Would put rename/delete/reorder where the
  user looks for them, but adds a control to the row this change is trying to
  quieten. Left open for the user to rule on.
