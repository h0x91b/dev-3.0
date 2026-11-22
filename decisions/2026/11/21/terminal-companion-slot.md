# The terminal's left companion on an internal `terminalCompanion` replace slot

## Context
Plan item 5.3 first proposed moving the file explorer into the task dock. `/ux-principal` rejected that: the explorer belongs to a terminal (task pane and Repo, where there is no task dock), as a tab it would hide behind every shown artifact, and it would lose its overlay-not-reflow, app-wide mode. The coordinator re-scoped 5.3 into a seam: the explorer moves onto Cordis without changing its placement or behaviour.

## Decision
- `src/mainview/terminal-companion/`: a replace-kind `TerminalCompanionRegistry`; `builtin:file-explorer` (the existing `FileExplorerFrame`) is its only, required item. `<TerminalCompanion>` takes `FileExplorerFrameProps`, the terminal as `children` included, and replaces `FileExplorerFrame` at both mount sites (`TaskWorkspacePane`, `ProjectTerminal`). Props travel by context (`useTerminalCompanionProps`), as for the sidebar slot.
- The companion lays itself out around the terminal, so the terminal keeps one tree position: the cold-start fallback and the registered built-in are the same component type, and nothing is keyed by task.
- **Crashes:** the built-in catches its own explorer crash inside its column (`ExplorerCrashed` in `FileExplorerFrame`: a wrapped, scrollable notice with Hide, reset on project/task change), so a broken explorer never remounts the terminal and its PTY. A crashing replacement falls back to the built-in under a notice (§5.12, replace slot), but the notice is one compact line with Dismiss above the tree, inside the explorer's own column (`FileExplorerFrame`'s `notice` prop). The host does not use `SlotHost`, whose notice sits above the content and would push the terminal down.
- Placement, the pinned/autohide/hidden mode, ⇧⌘E, the toggle and the <768px rule are untouched.

## Risks
- The replacement-crash notice lives in the explorer column, so in autohide it shows only when the tree is revealed, and in hidden mode not at all; the explorer stays usable either way.
- The slot's props include `children` (the terminal): fine internally; a public companion contract must decide whether an extension may wrap the terminal at all ("terminal renderer" is not a slot, §5.12).
- A replacement crash falls back by swapping the subtree, which does remount the terminal once. Unreachable today for two reasons: the extension guard unloads any extension that registers here, and the host only looks up `builtin:file-explorer`, whose id a second registration cannot take. The notice is exercised by the test alone, which registers a throwing component under that id before the built-ins load.
- Any companion swap, not only the crash fallback, remounts the terminal: loading a companion, unloading one (back to the built-in), or a crash. The PTY survives in tmux or the pty-server and the screen is replayed on reattach; what is lost is client-only state: scroll position, selection, focus, copy-mode viewport, and possibly native-backend scrollback deeper than the server's replay. Unreachable today for the same two reasons as above; `terminal-companion.test.tsx` pins the remount count and points here.
- A crash of the built-in frame itself (outside the explorer's own boundary) re-renders the built-in with no notice, since it is not a fallback to anything; the outer boundary resets per terminal folder, like the inner one.

## Alternatives considered
- The explorer as a task dock panel — rejected by `/ux-principal` (see Context).
- Slotting only the tree inside a host-owned frame — splits one component's layout rules (rail, overlay, resize) between host and item.
- Reusing `SlotHost` — its crash notice sits above the content and would reflow the terminal.
