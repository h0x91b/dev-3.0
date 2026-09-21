# The cwd's project scopes a task lookup; --project is the escape hatch

## Context

`dev3 peek --task seq:130` run inside a dev3 task worktree failed with
`Task ref seq:130 matches 3 tasks across projects … Pass --project to
disambiguate`. The caller was standing inside one of the three answers.

`peek` deliberately sent no `projectId` at all (the comment said a coordinator
peeks at peers in other projects, and the server resolves a bare ref across every
board). Since `seq` restarts at 1 on every board, a collision is the normal case,
not a corner one — so the command was unusable for its most common target, its
own project's tasks.

## Investigation

Resolution happens in two halves. The CLI decides what to send
(`resolveProjectId`, `src/cli/context.ts`) and the app decides how to look it up
(`resolveTaskAcrossProjects`, `src/bun/cli-socket-server.ts`): with a
`projectId` the lookup is restricted to that board, without one it scans all of
them and raises on a seq collision.

Auditing every project-scoped command showed `peek` and `pane` were the only two
that sent no project — 31 other call sites already passed
`resolveProjectId(args.flags.project, context)`. A second, quieter gap: that
helper only knew the task worktree, so every project-scoped command answered
"could not detect project" when run from the project's ordinary checkout.

## Decision

- `resolveProjectId` (`src/cli/context.ts`) falls back to `projectOwningCwd(cwd)`
  when no task context exists, so a plain checkout scopes a command like a
  worktree does. An explicit `--project` still wins, and the UI's focused project
  is deliberately not consulted — the target comes from where the shell is.
- `dev3 peek` and `dev3 pane` (`--project` added to all four pane subcommands)
  now send that project as `projectId`. The scope is a restriction, not a
  preference: a `seq` this board does not carry must never resolve to a stranger's
  task that happens to share the number.
- To keep that strictness actionable, a scoped miss names the boards that do
  carry the ref (`scopedTaskNotFoundError`), so the caller can aim `--project`
  without guessing.
- Outside any project (no worktree, no owning checkout) the CLI sends no project
  and the app keeps its existing cross-project search and collision error.

An earlier draft of this change made the cwd project a mere tie-breaker
(`preferProjectId`) that still fell through to other boards. It was rejected:
a seq absent locally would then silently resolve a foreign task.

## Risks

`dev3 peek --task seq:N` at a peer on ANOTHER board now needs `--project <id>`,
where it used to resolve bare. That is a deliberate behaviour change; the
not-found message hands over the exact flag to use.

## Alternatives considered

- Keep the cross-project default and only break ties towards the caller's board
  — rejected as above.
- Resolve the seq CLI-side from the data files and send a full UUID — duplicates
  the app's resolution offline and breaks when the data files are unreadable.
