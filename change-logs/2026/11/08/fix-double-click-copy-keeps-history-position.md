Short: Double-click copy keeps scroll position

Double-clicking a word or triple-clicking a line in terminal scrollback now copies that text and leaves the viewport where it was. Before, the first click returned the pane to live output, so the terminal jumped to the bottom and copied whatever sat under the pointer there instead.

Suggested by @DolevSol (h0x91b/dev-3.0#978)
