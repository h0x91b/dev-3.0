# File explorer panel beside the task terminal and the Repo screen

> Extended on 2026-11-15 by `decisions/2026/11/15/project-extra-folders.md`: a project can add extra folders, each listed as its own section of the same tree.

## Context

Browsing a task's files meant the inspector "Files" button, which split a tmux pane running yazi. yazi is a brew dependency the in-app updater never installs, it does not exist on native-backend (Windows) tasks, and nothing showed the project's own checkout. dev3 is a cockpit for agents, not an IDE, so a file tree has to earn its place without growing into an editor.

## Decision

A React panel (`FileExplorer.tsx`) laid out by `FileExplorerFrame.tsx`. **It always sits beside a terminal**, and lists that terminal's folder: the task worktree in `TaskWorkspacePane`, the project checkout on the `project-terminal` route, which the UI now calls **Repo** (header button, folder-and-prompt icon). The board carries no explorer: there `⇧⌘E` navigates to Repo with the tree shown (`toggleFileExplorerForRoute` in `menuRouter.ts`), and does nothing on a space board, a virtual board or the dashboard. One app-wide preference in `file-explorer-prefs.ts`: `pinned` docks a resizable column, `autohide` docks a 32px rail and slides the tree OVER the content, `hidden`.

- **Auto-hide overlays, never reflows.** Any width change on the terminal refits the PTY and the TUI repaints. Resizing the pinned column uses a ghost line and commits on release, like the artifact dock.
- **`children` keep one slot in every mode.** Returning a different tree per mode remounted `TaskTerminal` and reopened its PTY; a test fails if that comes back.
- **Insert path** goes through `terminal-paste-request.ts`, addressed by the terminal's session key (a task id, or `project-<id>` for Repo). Touch compose mode drafts it in the composer instead of typing past it.
- **Rooted RPC.** `listExplorerDirectory` takes `projectId`, optional `taskId` and a root-relative path, resolves the root itself and refuses anything resolving outside it.
- **Ignored entries** come from one `git ls-files --others --ignored --exclude-standard --directory -z -- <dir>` per listed directory. git names only the outermost ignored folder, so its subtree inherits the dimming in the renderer and is listed with `insideIgnored`, skipping git.
- **No watcher.** Expanded folders that are on screen re-list every 10s while the window is visible and on focus; a folder that disappeared is dropped from the expanded set.
- **yazi stays** as one item in the panel's "…" menu on tmux-backed tasks.

## Non-goals

A PR adding any of these is out of scope by this record: writing files (edit, create, rename, move, delete, drag-to-move); git actions or git status colouring (what changed belongs to the diff viewer); tabs or an editable preview; search inside files; a file watcher; a second visible toggle; per-task or per-project modes; new context-menu rows beyond open, copy path, insert path, open with system, reveal.

## Risks

The re-list runs one `git ls-files` per open directory. Ctrl+Shift+B may be taken by a browser extension in remote mode; the palette and the View menu remain. A name containing `'` is escaped the POSIX way, which PowerShell reads differently. Below 768px the panel is off until the narrow form ships.

## Alternatives considered

A rail beside the board (no visible entry point, squeezes the columns, nothing to insert a path into). A Board/Files view switch (a destination hidden in a toolbar, and a full-screen tree without a terminal drifts toward an IDE). A new top-level Files destination (the budget is spent). A file watcher. Keeping yazi as the only browser.
