Short: Ctrl+Backspace deletes a word in terminals

On Windows and Linux, Ctrl+Backspace in a tmux-backed terminal now deletes the word to the left in zsh, bash, vim, neovim and agent CLIs such as Claude Code, instead of a single character, and Ctrl+Delete deletes the word to the right at a shell prompt instead of typing junk like `;5~`, while full-screen editors such as neovim keep receiving the raw Ctrl+Delete. macOS keeps its own Option+Backspace convention, and Windows native terminals are unchanged.
