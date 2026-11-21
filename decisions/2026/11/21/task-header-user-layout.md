# Task-header user layout: registry ids, one global layout, measured budget

## Context
PR 3.6 of the Cordis GUI plan lets the user reorder, hide, pin and swap task-header items. Hidden controls were stored under a hand-written `HideableControlId` union (`spawn-agent`, `scripts-runner`, …) in `GlobalSettings.hiddenControls`, a field every installed version reads.

## Decision
- Header items are hidden by their `taskHeader` registry id (`builtin:session.spawn-agent`); `TaskHeaderItemId` replaced the hand-written members, the Simplify View preset included. The dev-server control became two items (`dev-server`, `dev-server-setup`) so the preset still hides only the set-up prompt.
- On disk, `normalizeSimplifiedInterface` (`src/shared/simplified-interface.ts`) maps the eight old names to registry ids on read and writes each old name next to its registry id in `hiddenControls`, so an older version still hides what the user hid. `personalHiddenControls` holds only registry ids; the renderer never sees the aliases (`hidden-controls.ts`). Remove the alias table once N-2 no longer predates 3.6.
- Order, More and pins live in a new optional `GlobalSettings.taskHeaderLayout` (`task-header/layout.ts`), global per the user's Q9. Hiding stays in `hiddenControls` with every other control; a swap writes both in one `patchGlobalSettings` call (`updateHiddenControls(change, extra)`).
- The layout and the item menu apply only to desktop bars. The narrow bar and sheet keep the default order, and the sheet gains restore rows (the touch path); desktop bars also open the menu on a touch long-press.
- `<SlotItems onItemMenu>` wraps each inline item in a `display: contents` marker that carries the gesture and lets the host see which items drew nothing. The budget counts only those that did, which makes the §5.1 exceptions effective. The More panel is portaled and fixed: the bars and the header clip their overflow.
- Built-ins have no menu-row form; in More they draw their bar form, and the panel focuses its first control.

## Risks
An older version that rewrites settings drops `taskHeaderLayout` (its loader whitelists fields): the layout resets, hides survive. The marker spans add one DOM level per item; nothing in the header styles direct children. A swap onto a hidden item whose `when` is false shows nothing until it applies.

## Alternatives considered
- Keep old ids for header controls: two id schemes for one registry. Rejected.
- Hidden set inside `taskHeaderLayout`: older versions and the Simplify View preset would stop seeing header hides. Rejected.
- Count rendered items with a pure `when(scope, layout)` per item: most items go blank from data deep inside them (no ports, no media). Rejected for measuring.
- A "Customize toolbar" button: the UX verdict keeps the right-click affordance as the only entry.
