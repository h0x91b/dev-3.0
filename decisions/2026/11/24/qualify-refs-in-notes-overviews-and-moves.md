# Qualify bare refs in notes, overviews and cross-project moves

## 1. Context

`decisions/2026/11/21/qualify-bare-refs-in-cross-project-text.md` qualifies a bare `seq:N` / `pr:N` in `task create` and `task update` text written from another board. Two other ways text reaches a board kept the bare form, so the ref resolved on the wrong board: a note or overview a coordinator on board A writes onto a task on board B, and a To Do task moved from board A to board B, whose text named A's tasks.

## 2. Decision

- `dev3 note add` and `dev3 overview set` send `sourceTaskId` from the CLI context, as `task update` does. `note.add` runs `qualifyRefsFor` and `overview.set` runs `qualifyEditedRefsFor` against the old overview (`src/bun/cli-socket/board-metadata-commands.ts`). `writerProjectIdFor` (`task-resolution.ts`) skips the board scan when a task writes to itself, the common case for an overview.
- `data.moveTaskToProject` qualifies the title, custom title, description, both overviews and every note against the source project. The history log keeps the text as it was.

## 3. Risks

- A ref already qualified with the target project stays qualified after a move. It still resolves, only less tersely.
- Moving a task back qualifies nothing new: the refs already carry the first board's qualifier.
- An older CLI sends no `sourceTaskId`, so its notes and overviews stay as written, the same as before.

## 4. Alternatives considered

- **Resolve bare refs in a moved task against its old project at render time**: rejected for the reason the 2026-11-21 record gives. The agent and the CLI read the stored text.
- **Plain `qualifyRefsFor` for overviews**: rejected. An agent that reads another board's overview and writes it back would turn that board's own `seq:3` into its own.
