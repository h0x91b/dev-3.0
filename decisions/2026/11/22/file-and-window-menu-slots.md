# File explorer and window tab menus on internal `fileMenu` / `terminalWindowMenu` slots

## Context
Batch item 1 of the off-Cordis inventory: the two context menus left after `taskMenu`
(`decisions/2026/11/21/task-menu-slot.md`). Explorer rows were a hard-wired `contextMenuSections()` in
`FileExplorer.tsx`; window tabs had three inline buttons in `TerminalWindowNav`'s `WindowMenu`.
Both slots are internal: no manifest kind, no public service, no API version bump.

## Decision
- **Shared helper.** `src/mainview/plugins/menu-rows.ts` holds what all three menus share: `MenuSlotItem`
  (region, guarded `label` / `when` / `disabled` / `checked`, `danger`), `resolveMenuRow`, `groupMenuRows`
  (built-ins by group, then one trailing group for anything else) and `runMenuItem` (sync and async throws
  logged, never escaping). A broken `when` / `label` is logged once per slot and id, because an open menu
  re-resolves on every host render; a failing run is one click and is logged every time. `useMenuSlotEntries` listens to the slot only while a menu is open, the
  rule <pr:2402> set for task menus, so the long-lived explorer does not re-render on slot changes.
  `TaskContextMenu` now uses all of it and keeps its `[taskMenu]` log lines.
- **`fileMenu`** (`src/mainview/file-menu/`). Groups `open` / `path` / `host`. The scope is the row's entry, whether
  it sits in the primary root, project and task, and the explorer's own `openFile` / `handOff` / `copyText` /
  `openWithSystem`, so toasts stay the explorer's. An item may carry an `icon` component, drawn inside its own
  boundary. The six built-ins moved out of `FileExplorer.tsx` with `quoteForShell`; the glyphs went to
  `file-menu/glyphs.tsx` and `fileManagerKeys` to `file-menu/file-manager.ts`, which the explorer header shares. The header "More" menu is not a row menu and stays host-owned.
- **`terminalWindowMenu`** (`src/mainview/terminal-window-menu/`). One group, `window`: switch (background windows
  only), rename, close (`danger`, only when closable). The scope is the window, task id, `closable` and the row's
  own `select` / `rename` / `close`.
- **Byte-identical.** Built-in rows keep the same elements, classes and order; there is no new budget, so no
  `/ux-principal` pass. Anything else lands after a rule below dev3's rows.
- **Tests.** Each slot has a `[dispose]` test on its surface and crash-escape rows (`when`, `label`, `run`, plus
  `icon` for `fileMenu`), mutation-checked.

## Risks
- `fileMenu` icons are trusted to be 14px glyphs; a wide one would push the label. Clamp it like
  `terminalTabDecorations` before the slot opens.
- Neither host has an extension budget yet: a long trailing group would make the menu tall. The opening track must
  set one (and then this goes through `/ux-principal`).
- `isElectrobun` gates the host rows inside their `when`; a plugin can still call `openWithSystem` in a browser,
  where the RPC fails with the explorer's own error toast.

- React keys and test ids strip `builtin:`, so a foreign item with a bare id such as `open` would collide with a
  built-in key. Impossible while the slots are internal; key foreign rows on their full id before opening.

## Alternatives considered
- **Two separate PRs without a shared helper.** Rejected: the guard and grouping code would exist three times.
- **Keep `danger` / `checked` / `disabled` on every menu item.** Rejected: the explorer menu draws none of them, so
  the item type would promise rendering that does not happen. Each slot omits what its host cannot draw.
- **Render the explorer rows through `TaskContextMenu`'s row component.** Rejected: different density, icons and
  no flyouts; it would break byte-identity.
