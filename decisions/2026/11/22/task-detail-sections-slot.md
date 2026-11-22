# A finished task's detail body as an internal `taskDetailSections` slot

## Context

Phase 4 of the GUI move to Cordis plugins (coordinator task seq:2526, inventory item 2.2) moves `TaskDetailModal`'s
body onto a contribution slot. The modal is two surfaces behind one component: a draft editor (rename, description,
labels, Run or Launch) and the read-only view of a completed or cancelled task. Three places open it: the card, the
task context menu and `BoardHost` (`detailTaskId`).

## Investigation

- A `/ux-principal` pass ruled that only the finished view is page-shaped. Sections inside the draft's edit form
  would break focus, its dirty state (`isEditing` blocks outside-click close) and the one-primary-action rule.
- Before anything moved, `TaskDetailModal-parity.test.tsx` pinned the markup of both views, at desktop and at 390px,
  for a task with every optional row and one with none. The same six snapshots pass after the move, byte for byte.

## Decision

- **Scope:** the finished view's body only. Its header (status menu, labels, Reopen), its title and the whole draft
  editor stay host-owned in `TaskDetailModal.tsx`.
- **Two regions** (`src/mainview/task-detail-sections/registry.ts`):
  - `main` (left column): built-ins `shared-outputs` → `description` → `notes`.
  - `meta` (the grid): one row per field, seq through moved. A built-in draws its own two `cells`; an extension row
    gives `label()` and `value`, and the host draws the cells.
- **Placement** (`TaskDetailSections.tsx`): built-ins first by registration, then extensions by `order`, so an
  extension never comes before a built-in. Extension budgets: `main` 2 sections, then one collapsed
  `More from extensions (N)` disclosure; `meta` 3 rows, the rest not drawn and logged once.
- **Failures:** every item sits in a `SlotErrorBoundary`. A crashed built-in `main` section leaves a one-line notice,
  because it may be what the agent shared. An extension's crashed item vanishes. A throwing `when`, `title` or
  `label` hides that item, logged once per id and failure.
- **Note handlers** reach the built-in Notes through `TaskDetailNoteActionsContext`, not the slot scope: they are a
  built-in exemption from the read-only rule.

## Risks

- An extension section's heading is its own `title()` for now. The verdict's host-drawn `From <extension name>`
  needs the extension's identity on the item; that and the over-budget reason are opening-track preconditions
  (`docs/extensions-platform.md`).
- Read-only is a rule, not an enforced boundary: extension code shares the renderer's JS realm.

## Alternatives considered

- **The whole modal as one slot, draft included.** Rejected for the edit-form reasons above.
- **Sorting built-ins by numeric `order`.** Rejected: an extension could pick a lower number and lead the page.
- **A disclosure for overflowing metadata rows.** Rejected: a glanceable fact grid gets no hidden part.
