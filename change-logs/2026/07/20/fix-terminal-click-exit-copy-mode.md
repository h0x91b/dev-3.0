Short: Terminal input resumes after copy

Terminal input now resumes without Escape after copying text: a plain terminal click exits retained tmux copy mode, and Back to Terminal restores focus after selecting text in Diff. Scrollback selection still preserves the viewport instead of jumping to live output.
