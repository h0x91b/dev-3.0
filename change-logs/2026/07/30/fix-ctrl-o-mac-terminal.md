Short: Ctrl+O reaches the terminal on macOS

On macOS the "Open in…" picker fired on Ctrl+O as well as ⌘O, and its capture-phase handler swallowed the keystroke before the focused terminal saw it — so Ctrl+O-bound features of the CLI running in the pane (Claude Code's transcript/expand toggle, for one) were unreachable. The shortcut now matches the keymap exactly: ⌘O on macOS, Ctrl+O elsewhere.
