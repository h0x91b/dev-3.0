# Qualify bare refs in text written for another board

## 1. Context

An agent on board A ran `dev3 task create --project B` for many boards and wrote "seq:60 split it per project" in each description. The task stored the bare `seq:60`, so every link resolved on board B and showed "No such task or PR on that board". The receiving agent had the same problem: `dev3 task show --task seq:60` reads board B's seq:60. `qualifyRefsFor` fixed this for agent messages only, and only for the bracketed `<seq:N>`, while agents mostly write the bare form.

## 2. Decision

- `qualifyRefsFor` (`src/shared/task-refs.ts`) gives the writer's project to each unqualified ref, bracketed or bare, and keeps its form: `seq:60` becomes `seq:a1c9fe4e/60`, because a card title renders as plain text, where `<...>` would show. This includes refs in markdown code and CLI arguments (`--task seq:4`, `dev3 task show seq:4`). A bare handle is never bracketed, because `<` is a shell redirection.
- The CLI resolves the qualified handle. `parseTaskHandle` reads `seq:<N>` and `seq:<project>/<N>`, and `normalizeTaskArg` unwraps a pasted `<seq:a1c9fe4e/N>`. On the server, `withQualifiedTaskRef` (`src/bun/cli-socket/task-resolution.ts`) runs on every request before its handler. A qualified `taskId` replaces the `projectId` the CLI stamped from the caller's worktree, and the handler gets the bare `seq:N`. The qualifier is matched by `projectMatchesQualifier`, so an id prefix or a project name works. No match, or more than one, is an error. `resolveTaskAcrossProjects`, `findTaskByRef` and the dependency lookup read the qualified form too, so `--depends-on seq:<other board>/3` is "not found" on this board instead of silently naming this board's seq:3.
- `task.create` (`src/bun/cli-socket/task-commands.ts`) qualifies the title and description against the creator task's project (`origin.projectId`). `task.update` does the same for a new title or description through `qualifyEditedRefsFor`, which keeps every line already in the old text: an agent on board A that reads board B's description and writes it back must not turn B's own `seq:3` into A's. The old title is the shown one (`getTaskTitle`), so an auto-generated title written back stays as it was. The CLI now sends `sourceTaskId` with `--title` / `--description`.
- Agent messages pick up the wider rule through the same function.

## 3. Risks

- A qualified handle overrides an explicit `--project` too, because the server cannot tell a flag from the worktree's own project. The qualifier is the more specific of the two.
- A ref inside a code sample that is not a dev3 command, such as quoted JSON, gains a qualifier as well. Such text is rare in task descriptions, and the qualified ref still names the right task.
- In an edit, a line the writer changed is qualified as a whole, so a target-board ref on the same line gains the writer's project too. A newly added line that matches an existing line exactly stays unqualified.
- A create or update with no source task (a plain shell, the GUI) has no writer project, so its text is stored as written.
- The CLI's local reads (`readTaskDirect`) do not resolve a qualified handle and treat it as unknown. The socket call resolves it.

## 4. Alternatives considered

- **Resolve bare refs against the task's `origin` at render time**: rejected. The receiving agent and the CLI read the stored text, and a later same-board edit would be misread.
- **Keep CLI arguments bare and qualify only prose**: rejected. A cross-board brief that says `dev3 task show seq:60` would still resolve on the reader's board, which is the original bug, and telling a CLI argument from prose needs a heuristic that misreads both ways.
- **Fall back to other boards when a bare ref is not found**: rejected. It is ambiguous whenever both boards have that seq, and seq numbers start at 1 on every board.
