# Epics are a global registry with a single per-task pointer, inherited at creation

## Context
Coordinators run efforts that span several projects, and nothing grouped their tasks: labels are per project, and lineage (`decisions/2026/10/28/task-origin-lineage.md`) records who created a task, not what it is for. A coordinator's children also create children, so "everything for Payments v2" needs a grouping the user owns and can name.

## Investigation
A global label would need a label registry outside `projects.json`, and `labelIds` is per-project and many-valued, so every label filter, the label editor and the label-count UI would have to learn a second id space. A lineage subtree is a fact, not an intent: a task created by hand for the same effort has no parent, and a coordinator often runs two efforts at once.

## Decision
`~/.dev3.0/epics.json` (`src/bun/epics-data.ts`, same identity-cached, file-locked, atomic-write pattern as the spaces registry) holds `{id, name, color, archived, createdAt}`; a task carries one optional `Task.epicId`. Names are unique case-insensitively and renaming is free because membership is by id. Epics are archived, never deleted, so no task ever points at a missing id. Inheritance happens once, in `epicForNewTask` (`src/bun/task-epics.ts`): a CLI create takes the creator task's epic across projects unless `--epic`/`--no-epic` says otherwise; editing a task's epic later never propagates. Variants and attempts copy it, a project move keeps it. Only the user or a coordinator may create an epic (exit 45); an unknown, ambiguous or archived reference exits 44.

## Risks
Older app versions ignore the additive field and keep it on edit (they spread the task), but cannot show or set it. One epic per task is a deliberate limit: many-to-many or epic "steps" would be an additive entity linking to tasks, not a change to `epicId`.

## Alternatives considered
Global labels: second id space inside `labelIds`, see above. Lineage subtree: wrong semantics. Propagating edits down the lineage: surprising, and a child moved to another effort would be dragged back. Hard delete: leaves dangling ids on tasks in every project.
