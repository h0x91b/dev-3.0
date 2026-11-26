# File preview and terminal links admit each project's extra folders

## Context

The file explorer lists a project's extra folders (`collectProjectFolders` in `src/bun/project-folders.ts`), but the preview, the terminal links and the open actions go through `allowedRoots` in `src/bun/rpc-handlers/terminal-paths.ts`: the home directory, the OS temp directories and each project's own path. A file in an extra folder outside those roots showed "File not found", because a refused path returned the same `not-found` kind as a missing file.

## Decision

`allowedRoots` also takes every project's extra folders that exist, from the same cached `resolveProjectFolders` the explorer uses, so anything the explorer lists can be opened. A folder that is a filesystem root (`dirname(path) === path`) is skipped, as `computeTempRoots` skips a `/` temp dir. `readFilePreview` returns `outside-allowed` for a refused path; a temp-dir path whose real path cannot be read stays `not-found` (`pathScope`). The preview shows its own message for `outside-allowed` and hides the open actions, as for `not-found`.

## Risks

A project's committed `.claude/settings.json` or `.code-workspace` file can now widen what the preview reads, not only what the explorer lists. That matches the explorer's existing exposure behind the same auth, and a folder that contains the project (`/mnt/e`) is admitted on purpose. Each gate call now resolves every project's folders; the 5 s cache in `resolveProjectFolders` bounds the config reads.

## Alternatives considered

Admit only the folders of the project the preview was opened from (rejected: `readFilePreview` has no project context, and every project's own path is already admitted globally). Report `not-found` with a hint (rejected: the message stays wrong for the explorer case, and the kind is what the UI keys on).
