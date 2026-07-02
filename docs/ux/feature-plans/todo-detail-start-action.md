# Feature plan — Start action in the To Do task-detail modal

## Feature request

From the To Do task-detail modal (opened by clicking a To Do card to read/edit the full
description), the user cannot start the task — no Run, no labels, no actions. They must close
the modal and use the card's Run button. The user asked to be able to start the task directly
from that view (and mentioned labels / active controls).

## Classification

- **User job:** start a queued task without leaving the detail view where they just read/edited it.
- **Owning object:** Task (status `todo`).
- **Feature class:** primary object action (Start) + object action (labels) + destructive action (Delete).
- **Scope:** single object.
- **Frequency:** Run — occasional-to-daily; labels/Delete — occasional.
- **Risk:** Run — safe (spawns a worktree via the standard picker); Delete — destructive (confirmed).

## Placement decision

Add a **sticky footer** to the compact (non-archived) `TaskDetailModal`, rendered **only for
`isTodo`**, sitting outside the scrollable content so it stays visible with long descriptions.

Rejected alternatives:

- **Header status-badge dropdown → Start** — hides the screen's primary action in a dropdown.
  Start must be a visible button.
- **Give To Do the rich ArchivedView layout** — larger surface/refactor than the job needs.
- **No modal change (rely on card Run)** — that is the current gap being fixed.

## Action hierarchy & tokens

- **Run** — semantic role `primary`; concrete variant = solid green button (`bg-green-600`,
  play glyph), mirroring the card's Run so the launch affordance reads identically. Right-aligned.
  Behavior: `onClose()` then `onLaunchVariants(task, "in-progress")` → the canonical
  `LaunchVariantsModal` (agent + variant picker). Never bypasses the launch flow.
- **Labels** — object action near the object: an editable chip row (existing `LabelChip` +
  `LabelPicker`), matching the card's inline editor. Above the action row.
- **Delete** — `destructive`, low-emphasis (ghost text button, danger on hover), left-aligned to
  keep placement friction away from Run. Uses the imperative `confirm()` service before deleting.

## Interaction details

- Footer only renders for `status === "todo"`; active and archived tasks are unaffected.
- Esc precedence: label picker → status menu → rename → description edit → close modal.
- Delete disables both footer buttons while the delete request is in flight.
- All actions work identically in desktop and browser mode (no native dialogs; `confirm()` +
  toast services only).

## Files changed

- `src/mainview/components/TaskDetailModal.tsx` — new footer + `onLaunchVariants` prop + Run/Delete/label handlers.
- `src/mainview/components/TaskCard.tsx` — thread `onLaunchVariants` into `TaskDetailModal`.
- `src/mainview/components/__tests__/TaskDetailModal.test.tsx` — footer coverage.
- `src/mainview/tips.ts` + i18n `tips` files — discovery tip.

## Not in scope

- No labels/Delete footer for active or archived tasks (they navigate into the workspace / are read-mostly).
- No new status dropdown in the To Do modal — Run is the only meaningful forward transition.
