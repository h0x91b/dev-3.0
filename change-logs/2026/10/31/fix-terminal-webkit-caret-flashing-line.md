Short: No more flashing line beside the terminal

A focused terminal no longer shows a blinking blue line along its left edge (between the task list and the terminal). It was WebKit's native text caret, painted because the terminal element is editable; it is now transparent, and the terminal's own cursor still shows where focus is.

Suggested by @TedFintastic (h0x91b/dev-3.0#2124)
