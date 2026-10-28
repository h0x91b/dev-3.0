# Task origin (lineage) is a creation-time fact, separate from epics and labels

## Context
Parallel coordinators create many tasks across projects, and nothing recorded who created a task, so "what did #1801 create?" had no answer. PR #2030 (cross-project epics) groups tasks by intent; this is about provenance.

## Decision
`Task.origin` (`src/shared/types/task-origin.ts`) is a discriminated union — `user` (absent field), `task {taskId, projectId}`, `automation`, `import`. It is written only by `data.addTask` and stripped from every update in `applyTaskUpdate`; the GUI `createTask` RPC drops it, so only the CLI socket (`creatorOrigin` in `cli-socket/task-commands.ts`) records a parent: whatever task context the CLI ran in, no agent-vs-human detection. An unresolvable creator falls back to the user and never fails the create. Variants and attempts copy the source's origin so a variant group stays one node; a child created by a variant points at that exact variant. Only ids are stored — seq, title and project name are resolved at read time (`task-lineage.ts`, `withOriginParent`), because seq changes when a task moves between projects.

## Risks
A parent moved to another project keeps its id, so lookups by id still work, but `origin.projectId` becomes a stale hint — readers must resolve by id across projects, never trust it. Older app versions ignore the additive field.

## Alternatives considered
Reusing epics or labels: both are editable groupings the user owns; lineage must stay a trustworthy fact, so it gets its own immutable field. Storing a seq/title snapshot: goes stale on move/rename. Detecting "agent vs human" at the CLI: unreliable, and a simple rule (task context ⇒ parent) is testable.
