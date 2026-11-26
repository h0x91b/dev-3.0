# Qualify bare refs in notes, overviews and cross-project moves

## 1. Context

`decisions/2026/11/21/qualify-bare-refs-in-cross-project-text.md` qualifies a bare `seq:N` / `pr:N` in `task create` and `task update` text written from another board. Two other ways text reaches a board kept the bare form, so the ref resolved on the wrong board: a note or overview a coordinator on board A writes onto a task on board B, and a To Do task moved from board A to board B, whose text named A's tasks.

## 2. Decision

- `dev3 note add` and `dev3 overview set` send `sourceTaskId` from the CLI context, as `task update` does. `note.add` runs `qualifyRefsFor`, as `task create` does for new text, and `overview.set` runs `qualifyEditedRefsFor` against the old overview (`src/bun/cli-socket/board-metadata-commands.ts`). `writerProjectIdFor` (`task-resolution.ts`) skips the board scan when a task writes to itself, or, for a note, when the writer is on the same board.
- `data.moveTaskToProject` qualifies the title, custom title, description, both overviews and every note against the source project. A ref to the moved task itself becomes its new seq, bare (`renumberSelfRefs` in `src/shared/task-refs.ts`). It matches the source project by id prefix or by name (`projectMatchesQualifier`), so a hand-written `seq:<project-name>/7` follows the task too. A `seq:N --project P` ref is left as written, because its project comes from the flag. The history log keeps the text as it was.

## 3. Risks

- A ref already qualified with the target project stays qualified after a move. It still resolves, only less tersely.
- Moving a task back qualifies nothing new: the refs already carry the first board's qualifier.
- An older CLI sends no `sourceTaskId`, so its notes and overviews stay as written, the same as before.
- Refs to the moved task from tasks left on the source board are not rewritten; they now name a seq the source no longer has, as before this change.
- The old overview and notes are read before the write lock, so two writers at once can qualify a line the other just added.

## 4. Alternatives considered

- **Resolve bare refs in a moved task against its old project at render time**: rejected for the reason the 2026-11-21 record gives. The agent and the CLI read the stored text.
- **The edit rule for notes, against the task's existing notes**: rejected. Notes repeat lines ("Blocked on seq:12"), so a new note from another board would keep a bare ref that names the wrong board. A note that quotes an earlier one re-qualifies the quote instead.
- **Plain `qualifyRefsFor` for overviews**: rejected. An agent that reads another board's overview and writes it back would turn that board's own `seq:3` into its own.
