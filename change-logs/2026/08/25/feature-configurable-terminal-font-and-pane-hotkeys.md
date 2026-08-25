Short: Terminal font and pane hotkeys

Settings → Terminal now has a terminal font family and font size, applied live to every open terminal on that device; typing a font the machine does not have falls back to the bundled JetBrains Mono and says so. Pane zoom and pane swap also got prefix-free, rebindable shortcuts (⇧⌘Enter to zoom, ⇧⌘, / ⇧⌘. to swap) that work on the native backend and in the browser, where tmux's ⌃B z / { / } are not available — swap is new on the native backend and is also reachable from the pane layout menu and the Terminal menu (#1514).

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1511)
