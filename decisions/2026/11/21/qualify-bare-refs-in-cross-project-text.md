# Qualify bare refs in text written for another board

## 1. Context

An agent on board A ran `dev3 task create --project B` for many boards and wrote "seq:60 split it per project" in each description. The task stored the bare `seq:60`, so every link resolved on board B and showed "No such task or PR on that board". The receiving agent had the same problem: `dev3 task show --task seq:60` reads board B's seq:60. `qualifyRefsFor` fixed this for agent messages only, and only for the bracketed `<seq:N>`, while agents mostly write the bare form.

## 2. Decision

- `qualifyRefsFor` (`src/shared/task-refs.ts`) gives the writer's project to each unqualified ref, bracketed or bare, and keeps its form: `seq:60` becomes `seq:a1c9fe4e/60`, because a card title renders as plain text, where `<...>` would show. A bare ref stays as written when it is a CLI argument: inside markdown code (inline or fenced), after a `--flag` (`--task seq:4`, `--depends-on seq:3,seq:4`), or as the positional id of `dev3 <command> <sub>`.
- `task.create` (`src/bun/cli-socket/task-commands.ts`) qualifies the title and description against the creator task's project (`origin.projectId`). `task.update` does the same for a new title or description, and the CLI now sends `sourceTaskId` with `--title` / `--description`.
- Agent messages pick up the wider rule through the same function.

## 3. Risks

- A command written in plain prose without code formatting, such as "then run dev3 note add seq:4", is recognised only in the forms above. Another shape gets a qualifier, and the reader's command fails loudly. Before, it silently hit the wrong board's task.
- A bare ref in markdown code stays bare, so in a cross-board description a ref written as `` `seq:60` `` still links to the reader's board.
- A create or update with no source task (a plain shell, the GUI) has no writer project, so its text is stored as written.

## 4. Alternatives considered

- **Resolve bare refs against the task's `origin` at render time**: rejected. The receiving agent and the CLI read the stored text, and a later same-board edit would be misread.
- **Fall back to other boards when a bare ref is not found**: rejected. It is ambiguous whenever both boards have that seq, and seq numbers start at 1 on every board.
