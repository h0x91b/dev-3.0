# One task context menu, shared by the Kanban card and the Active Tasks row

> Updated on 2026-11-21 by `decisions/2026/11/21/task-menu-slot.md`: the rows and their actions are now
> built-in items of the `taskMenu` slot (`src/mainview/task-menu/builtins.tsx`); `TaskContextMenu.tsx` only hosts them.

> Corrected on 2026-11-16 by `decisions/2026/11/16/phone-task-actions-sheet-is-the-complete-inventory.md`:
> long-press opens this menu on the Active Tasks row only. `TaskCard` wires right-click alone, and
> its long-press stays the native drag on purpose.

## Context

The Active Tasks sidebar row is a navigator with a hard budget (bible §10: two resting
controls plus the hover eye), so labels, rename, move-to-project, the copies and delete had
no way in at all from that surface. Right-click on a Kanban card opened `OpenInMenu` — the
external-app list and nothing else.

## Decision

`src/mainview/components/TaskContextMenu.tsx` is ONE menu for the task object, mounted by
`ActiveTaskRow` and by `TaskCard`, opened through `hooks/useContextMenu.ts` (right-click on
both; long-press on touch and Shift+F10 / the Context-menu key on the focused row, sidebar only). It owns no
action of its own: every row hands off to the picker, modal or RPC that already existed —
`LabelPicker`, `PriorityPicker`, `PipelineDropdown`, `MoveToProjectPicker`, `OpenInMenu`,
`TaskDetailModal` (with the new `autoRename` prop for "Rename…"), and the watch / hidden /
hibernate / delete RPCs.

The menu deliberately **repeats** controls the surface already shows (priority, move-to,
hide). The manifest's no-second-entry-point rule is about persistent chrome; a context menu
is reached blind, and a user who right-clicks should not have to remember which half of the
actions lives on the row.

The card's action-strip "Open in" button still opens `OpenInMenu` directly — that is a
visible control, not the right-click path.

## Risks

- Two surfaces now share one menu, so an action added for the board also appears in the
  sidebar. That is the point, but a board-only action would need an explicit prop.
- `Delete task…` is now one right-click away on both surfaces. It is `text-danger`, last,
  after a separator, and always confirmed.

## Alternatives considered

- **Only the actions the row lacks.** Rejected by the user: a context menu that is missing
  the obvious entries reads as broken.
- **Sidebar only, leaving the card's Open-in menu alone.** Rejected — the two surfaces would
  drift, and the card's right-click is the weaker of the two.
- **Hover submenus for Labels / Priority / Move to.** Rejected: the existing pickers are
  portalled popovers with their own search, keyboard handling and viewport clamping.
  Clicking the row hands off to them anchored at the cursor instead.

## Implementation notes worth keeping

`useOverlayLayer` registers on MOUNT with `[]` deps, so a panel that merely *appears* inside
an always-mounted host never joins the Escape/Tab stack — it stayed open on Escape until the
panel was extracted into `MenuPanel`, which mounts only while open. And the first row can
only take focus once the panel is measured: it renders `visibility: hidden` for one frame,
and a hidden element does not accept `focus()`.
