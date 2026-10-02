# File explorer panel beside the terminal and the board

## Context

Browsing a task's files meant the inspector "Files" button, which split a tmux pane running yazi. yazi is a brew dependency the in-app updater never installs, it does not exist on native-backend (Windows) tasks, and it had no counterpart on the board.

## Decision

A React panel (`FileExplorer.tsx`) laid out by `FileExplorerFrame.tsx`, mounted in `TaskWorkspacePane` (root = task worktree) and around the board in `ProjectView` (root = project checkout; off for space boards and virtual projects). One app-wide preference in `file-explorer-prefs.ts`: `pinned` docks a resizable column, `autohide` docks a 32px rail and slides the tree OVER the content, `hidden`.

- **Auto-hide overlays, never reflows.** Any width change on the terminal refits the PTY and the TUI repaints. Pinned pays that once per pin; hover reveals must not pay it at all. Resizing the pinned column uses a ghost line and commits on release, like the artifact dock.
- **`children` keep one slot in every mode.** Returning a different tree per mode remounted `TaskTerminal` and reopened its PTY; a test fails if that comes back.
- **Task-scoped RPC.** `listExplorerDirectory` takes `projectId`, optional `taskId` and a root-relative path, resolves the root itself and refuses anything resolving outside it. The renderer never sends an absolute path to list. Symlinks are followed without a realpath check, same as `decisions/2026/08/06/terminal-file-path-links.md`; `listDirectory` already lists any path behind the same auth.
- **Ignored entries** come from one `git ls-files --others --ignored --exclude-standard --directory -z -- <dir>` per listed directory, filtered to direct children. `git check-ignore -z` needs stdin, which `git.run` does not pass. Any git failure lists the directory undimmed.
- **No watcher.** Open directories re-list every 10s while the window is visible and on window focus, plus a manual refresh.
- **yazi stays** as one item in the panel's "…" menu on tmux-backed tasks (`useYaziLauncher.tsx`). The Files button toggles the panel.
- **Shortcut** ⇧⌘E on macOS (VS Code's), Ctrl+Shift+B elsewhere because Ctrl+Shift+E already splits a pane there.

## Risks

The 10s re-list runs one `git ls-files` per open directory; on a very large repo with many open folders that is noticeable CPU. Ctrl+Shift+B may be taken by a browser extension in remote mode; the palette and the View menu remain.

## Alternatives considered

A file watcher over the worktree (more moving parts, platform differences, and agents write in bursts). Showing only the project checkout in the task view (stale: the agent's edits live in the worktree until merge). Keeping yazi as the only browser (dependency, no Windows, no board).
