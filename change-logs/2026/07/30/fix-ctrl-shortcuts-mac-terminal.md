Short: Ctrl+Q/H/N/P/K/G/[ reach the terminal on macOS

Following the Ctrl+O fix, seven more app shortcuts claimed their Ctrl form on macOS and swallowed the keystroke before the focused terminal saw it — Ctrl+Q (unfreeze output), Ctrl+H (backspace), Ctrl+N/Ctrl+P (shell history), Ctrl+K (kill to end of line), Ctrl+G (abort input) and Ctrl+[ (escape). They now match the keymap exactly: ⌘ on macOS, Ctrl elsewhere, with a regression test over the whole set.
