# File paths in task text link to the in-app preview

## 1. Context

Agents name files in task descriptions, notes and overviews ("Brief: todo/x.md", "`src/app.ts:12`"). The terminal already turns such paths into links, but the same text in a description stayed inert, so the reader copied the path into a terminal or an editor by hand.

## 2. Decision

- **Detection reuses the terminal's.** `findPathCandidates` (`terminal-file-links.ts`) finds candidates. `resolveTerminalPaths` checks them on disk against the task's worktree and the project root, with the same allowed-roots gate and the same unique-suffix fallback. A candidate that names nothing stays plain text, so prose never gets a dead link.
- **One RPC per scope.** `text-path-links.ts` batches every candidate rendered in one tick into one call per project/task pair and caches answers for 15 s.
- **Surfaces.** `TaskRefText` (notes, overview, traffic, terminal preview) and the task description markdown. In markdown, a bare path, an inline code span that is one whole path, and a relative link (`[brief](todo/x.md)`) all link. Fenced code stays plain. Dense list rows (board table cells, the Active Tasks sidebar) pass `pathLinks={false}`, because every row would cost its own RPC.
- **Click** goes through `activateTerminalPath`, so it honours the terminal's open mode: the in-app preview by default and always in the browser. A `:line` suffix scrolls the preview to that line. In markdown the line rides as `#L<n>`, because `a.ts:12` would parse as a URL scheme.
- **Label.** An absolute or `~/` path shows its file name, and a relative path shows as written. The full path is in the hover tooltip, which streamer mode blurs. The written path stays in the DOM as `sr-only` text, so a copy of the sentence carries the full path, not the short label.
- **Folders** link only in the desktop app. The browser cannot open a host folder, so there a folder stays text instead of linking to a toast.
- **Chips are selectable.** The global `button { user-select: none }` dropped every ref chip from a copied sentence. Inline ref and path chips are prose that happens to be clickable, so they opt back in with `select-text`.

## 3. Risks

- A word that happens to match a file name (`README.md`) links, the same as in the terminal. The unique-suffix rule keeps an ambiguous name unlinked.
- A file created after the text rendered stays plain until the 15 s cache entry expires.
- Starting a drag selection on a chip clicks it, as on any button.

## 4. Alternatives considered

- **Link every path-shaped token without checking the disk**: rejected. Prose is full of `and/or` and `e.g.`.
- **A hover card like the task preview**: rejected for now. A tooltip with the full path answers "which file", and the preview itself is one click away.
- **Show the full path in the chip**: rejected. An absolute path is mostly home-directory noise and leaks it into screenshots.
