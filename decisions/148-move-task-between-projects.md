# 148 — Move a To Do task between projects

## Ubiquitous language

- **Move task to project** — relocating a *single To Do (backlog) task* from its
  current project's board to another project's board. It is a **true move**, not a
  copy: the task keeps its identity and disappears from the source board.
- **Portable fields** — task fields that survive the move unchanged (title,
  description, overview/userOverview, notes, history, priority, watched,
  provenance like `automationId`).
- **Project-scoped fields** — fields whose values only make sense within one
  project (`seq`, `projectId`, `baseBranch`, `labelIds`, `customColumnId`). These
  are re-derived or remapped on move, never carried verbatim.

## Context

Users occasionally create a task on the wrong board. There is currently no way to
relocate it; the only workaround is to re-type it in the right project and delete
the original. We want a first-class "move this task to another project" action.

Scope is intentionally limited to **To Do** tasks. A backlog task has
`worktreePath: null`, `branchName: null`, and no tmux session, so relocating it is
a pure data operation — no git worktree, branch, or terminal to migrate across
repos. Active tasks would require migrating live git/tmux state and are out of
scope.

## Investigation

- Tasks are stored per-project (`~/.dev3.0/data/<slug>/tasks.json`); `seq` is
  assigned by `nextSeq()` scanning that project's tasks, so it is **project-scoped**
  and must be reassigned on move. Task `id` is a UUID independent of project
  (`src/bun/data.ts`).
- `addTask()` already accepts `notes`, `overview`, `userOverview`, `priority`,
  `labelIds`, `customTitle`, `titleEditedByUser`; `deleteTask()` just filters the
  task out of the source file (safe for To Do — no worktree teardown needed).
- `Label`s and `CustomColumn`s belong to `Project` (`src/shared/types.ts`), so a
  moved task's `labelIds` reference labels that do not exist in the target.
- `TaskCard.handleContextMenu` is gated `if (!task.worktreePath) return`, so To Do
  cards have no right-click menu today; a To Do card click opens `TaskDetailModal`
  (`TaskCard.tsx`), which is the shared desktop+mobile detail surface.
- The modal is a fixed-width `w-[35rem]` centered dialog — an anchored popover
  inside it is cramped on a phone. The app's established mobile pattern is a
  bottom `BottomSheet` action sheet (`TaskInfoPanel`, `GlobalHeader`).

## Decision

Add a **new RPC handler `moveTaskToProject({ taskId, fromProjectId, toProjectId })`**
(UI only for now — no CLI command). It runs under both projects' file locks and:

1. Loads the source task; **rejects** if `status !== "todo"` (backlog-only).
2. Keeps the **same `id`**; sets `projectId = target`, `seq = nextSeq(targetTasks)`,
   `baseBranch = deriveTaskBaseBranch(targetProject)`, clears `opsWorkDir` and
   `customColumnId`.
3. **Labels: match by name.** For each source `labelId`, look up the source label's
   name and attach the target project's label with the same name if one exists;
   otherwise drop it. No labels are auto-created.
4. **Clears `scheduledLaunch`** (a deferred "Start in…" carries an agent/branch
   config from the old project context that must not fire in the new one).
5. Appends the moved task to the target `tasks.json` and removes it from the source
   `tasks.json`. Pushes `taskUpdated`/removal to all renderers.
6. **Cross-kind allowed** (git↔git, git↔virtual, virtual↔virtual): a To Do task has
   no git state, so the re-derived `baseBranch` / cleared `opsWorkDir` cover it.

UI: a **"Move to project…"** action in `TaskDetailModal` (next to Delete). It opens
a **searchable project list** (current + deleted projects excluded). On desktop the
list is an anchored popover; on mobile it renders as a bottom `BottomSheet`.
**No confirmation dialog** — picking the target is the confirmation, and the move is
reversible by moving back; a success toast reports the destination.

## Risks

- **Label loss is silent.** A source label with no same-name twin in the target is
  dropped without warning. Mitigated by the match-by-name rule keeping common tags
  and by the move being reversible.
- **Same-`id` move across project files** must be atomic-enough that a crash between
  the two writes cannot duplicate or lose the task. Append-to-target-then-remove
  order + the existing read-back verification (`addTask` pattern, decision 082)
  bound the worst case to a harmless duplicate, never a loss.
- **Mobile modal width** (`w-[35rem]`) is a pre-existing constraint; the BottomSheet
  picker sidesteps it for this flow but the modal itself is not re-fitted here.

## Alternatives considered

- **Copy + delete with a new `id`** — literal reading of the request, but loses
  `createdAt`/continuity; rejected in favor of a true move.
- **Recreate missing labels in the target** — keeps all tags but breeds
  near-duplicate labels across projects; rejected for match-by-name-or-drop.
- **CLI command / right-click on To Do / drag onto a sidebar board** — deferred;
  the modal action is the single home for v1.
- **Block move when `scheduledLaunch` is set** — safe but annoying; chose to clear
  it instead so the move always succeeds.
- **Confirm dialog / Undo toast** — unnecessary for a reversible action; plain
  success toast chosen.

## Implementation notes

- `data.moveTaskToProject(source, target, taskId, dropPosition = "bottom")` — the
  4th arg honors the user's `taskDropPosition` by reassigning `columnOrder` across
  the target To Do column (same logic as `applyTaskUpdate`'s drop handling). The
  RPC handler sources it from `loadSettings()`.
- **Renderer sync uses a new `taskRemoved` push** `{ projectId, taskId }` for the
  source board, alongside the existing `taskUpdated` for the target. There was no
  removal push before (local delete only dispatched `removeTask` in the initiating
  window). The `removeTask` reducer action gained an optional `projectId`: a
  `taskRemoved` for the SOURCE must NOT strip the freshly-added card from a window
  viewing the TARGET (same task id), so the reducer only filters when the shown
  board matches. `taskRemoved` is also added to the cross-instance broadcast
  whitelist (`shared-pure.ts` + `cli-socket-server._notify`) so separate app
  processes stay consistent — otherwise the auto-broadcast `taskUpdated` would
  upsert the moved card into another instance's source board as a phantom.
- Lock order is the two task files sorted lexicographically (not source-then-
  target) so concurrent A→B and B→A moves cannot deadlock.
- UI: `MoveToProjectPicker.tsx` (portal popover on desktop like `LabelPicker`,
  `BottomSheet` under 768px like `FilterFunnel`); wired into `TaskDetailModal`'s
  To Do footer next to Delete.
