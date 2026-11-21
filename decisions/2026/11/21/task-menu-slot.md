# Task context menu on an internal `taskMenu` slot

## Context
Plan item 4.2 (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): `TaskContextMenu.tsx` built its rows
from five hard-coded group arrays and kept every action's body inline, so the card, the sidebar row and every board
view (all mount the same component) could only gain a row by editing the menu itself. Internal first, like the
`commands` slot: built-ins only, no manifest kind, no public service, no API version bump.

## Decision
- `src/mainview/task-menu/registry.ts`: `TaskMenuRegistry`, a contribute-kind `SlotRegistry` of `TaskMenuItem`.
  `region` is the group (`open | edit | workspace | session | danger`, `TASK_MENU_GROUPS` order). An item resolves
  `label`, `when`, `disabled`, `checked` against a `TaskMenuScope` (task, own project, dispatch, `t`, the surface's
  `openTask` / `openDetails` / optional `showFamily`) and carries either its own `run(scope)` or a `submenu` with a
  desktop `flyout` and a phone `sheet`.
- `task-menu/builtins.tsx` registers the 20 built-in rows in the old order as one required built-in plugin started
  in `main.tsx`. The hard-coded groups and inline handlers are gone from `TaskContextMenu.tsx`, which is now only the
  host: layout, separators, hover/keyboard flyouts, the phone sheet hand-off and the detail modal.
- Any item whose id is not `builtin:` lands in one trailing host-owned group, whatever `region` it names — the
  bible's future "Extensions" section, never interleaved. No heading yet; it gets one when the slot opens.
- Parity is pinned by `components/__tests__/TaskContextMenuParity.test.tsx`, whose snapshot was recorded from the
  old hard-coded groups (its own commit) over 16 task states × card / sidebar / board props, desktop and phone.

## Risks
- Built-ins use internals (`api`, `dispatch`) through the scope: the recorded tech debt shared with the other slots.
  `TaskMenuScope` must not become the public contract as is.
- A throwing rule drops only its row (logged); a throwing `run()` is not yet reported into an extension's failure state.
- Cordis applies a plugin on a later tick after a root reset, so slot tests settle one tick before rendering.

## Alternatives considered
- One item per group with a component body — keeps the action lists hard-coded, just moved.
- Letting each item draw its own row — every contributor could break keyboard navigation and the flyout geometry.
