# The "Did you know?" tips as an internal `tips` slot

## Context

Phase 4 of the GUI move to Cordis plugins (coordinator task seq:2526, inventory item 2.7) moves the feature tips
off the hard-coded `ALL_TIPS` array onto a contribution slot, built-ins only, with no visible change. The rotation
is order-sensitive: `selectTip` picks within a score tier by index, so the order of the tip list is part of what
the user sees.

## Decision

- `src/mainview/tips/registry.ts` declares the internal `tips` slot. A tip is data (`titleKey`, `bodyKey`, `icon`,
  `score`, `contexts`, `settingsSection`) plus an optional `when()`. The `TipScore` rubric lives on the type there.
- `src/mainview/tips/builtins.ts` registers `BUILTIN_TIPS` in the old order, as one required built-in plugin.
- `src/mainview/tips/rotation.ts` (the old `tips.ts`) keeps rotation, cool-down and snooze in the host.
  `selectTip(tips, state, context)` now takes the registered list. `useTipRotation` subscribes to the slot, so
  unloading a plugin takes its tip off the card.
- Built-in ids are `builtin:tip.<key>`, and `tipStateKey()` strips the prefix. The persisted `TipState.seen` map
  keeps its old keys, so nothing on disk changes and every installed version reads the same state.
- The agent-traffic tip's special case in `availableTips` became that tip's `when()`.
- A throwing `when()`, or malformed `contexts`/`score`, hides that tip and logs once per tip and failure.
- `src/mainview/tips/__tests__/rotation-pin.test.ts` pins the whole registry and every surface's full rotation in
  a file snapshot. It was taken on main before the move.

## Risks

Renaming a built-in tip's key resets its cool-down for every user. The AGENTS.md tips section says not to.
Extensions cannot register tips yet (the guard unloads them). Opening the slot needs ranking and i18n rules first,
listed as preconditions in `docs/extensions-platform.md`.

## Alternatives considered

- Bare ids for built-ins (no `builtin:` prefix): rejected. Other slots treat the prefix as the built-in marker.
- Migrating the persisted `seen` keys to the prefixed ids: rejected. It is a destructive rewrite of shared on-disk
  state, which other installed versions read.
- Keeping `ALL_TIPS` as the source and mirroring it into the slot: rejected. That would be two sources for one list.
