# Path tokens in notes, overviews and cross-project moves

## 1. Context

`decisions/2026/11/24/cross-project-path-tokens.md` qualifies a plain relative path in `task create` and `task update` text written from another board. A note or overview written from another board, and a To Do task moved to another project, kept the plain path, which then resolved against the wrong project root. `decisions/2026/11/24/qualify-refs-in-notes-overviews-and-moves.md` closes the same gap for `seq:` refs.

## 2. Decision

- `note.add` runs `qualifyWriterPaths` and `overview.set` runs `qualifyEditedWriterPaths` after the ref qualification (`src/bun/cli-socket/board-metadata-commands.ts`). Both drop agent annotations first, as the plain `withoutAbsolutePaths` call they replace did.
- `data.moveTaskToProject` runs `qualifyPathsFor` with the source project as writer and the target as reader, on the description, both overviews and every note. Titles keep only the ref qualification, as at creation. The check is synchronous (`writerOnly`, moved to `path-ref-resolve.ts` so `data.ts` can use it without an import cycle) and runs inside the move's file locks.
- A path both projects hold stays as written, the same ambiguity rule as at creation.

## 3. Risks

- The move checks the disk while it holds both task-file locks. At most 64 distinct paths per text are checked, so the lock is held a few milliseconds longer.
- A file created in the source after the move is not picked up; the text was rewritten once, at move time.
- A task moved from a virtual (Operations) board has no project root, so its paths stay as written.

## 4. Alternatives considered

- **Rewrite paths in the RPC handler before calling `data.moveTaskToProject`**: rejected. The text would be read outside the lock, so a note added during the move could be lost.
