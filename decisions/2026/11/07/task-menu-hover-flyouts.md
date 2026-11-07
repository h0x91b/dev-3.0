# Task menu: hover flyouts

## Context

The task context menu (`TaskContextMenu.tsx`) showed a submenu arrow on Labels, Priority and Move to, but a click closed the menu and opened a separate picker at the cursor. Every change cost two clicks, and toggling several labels meant reopening the menu each time.

## Decision

On desktop, Labels, Priority, Move to, Move to project and Open in open their picker beside the menu, using the header kebab's rule in `PRODUCT_UX_BIBLE.md`: the same `MENU_FLYOUT_HOVER_MS` dwell and the shared `computeMenuFlyoutPosition` geometry (`src/mainview/utils/menuFlyout.ts`), here preferring the right side. The flyout is a `position: fixed` child of the menu panel, not a portal, so the panel's click-outside and focus-out handling count it as inside without a `data-*` exemption. Labels toggle without closing the menu. Hover never moves focus; a keyboard open focuses the current value or the search field, after the flyout is measured, because a browser ignores `focus()` inside the hidden first frame. The pickers' bodies were split out (`LabelPickerPanel`, `PriorityList`, `MoveToProjectPanel`, `OpenInAppList`) so the popover, the sheet and the flyout share one implementation. Narrow viewports keep the tap-through sheets.

## Risks

A fixed-position child depends on the menu panel having no `transform`, `filter` or `contain` ancestor style; adding one would make the flyout position relative to the panel. A pointer user who wants to search labels or projects clicks into the search field first.

## Alternatives considered

Portaled flyouts like the header kebab: they need an outside-click exemption on both sides. Showing every label and column inside the menu: the menu would grow with the label and column count and push Open, Rename and Delete below the fold. Inline P0-P4 buttons in the Priority row: one click fewer, but the row broke the menu's alignment, so it was dropped in review.
