Short: Placeholder text is gray again

Dim text in Claude Code and Codex — input placeholders, hints, select-prompt descriptions — rendered at full brightness instead of gray. The tmux Catppuccin pane style paints every default-fg cell with an explicit truecolor foreground, which made the terminal color filter treat those cells as an app-chosen color and drop the dim; dim is now tracked as independent terminal state and the pane-style foreground no longer counts as a color.
