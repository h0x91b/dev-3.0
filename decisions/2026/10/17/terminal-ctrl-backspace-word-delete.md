# Ctrl+Backspace / Ctrl+Delete delete a word in tmux terminals

## Context
ghostty-web encodes Ctrl+Backspace as `^H` and Ctrl+Delete as `CSI 3;5~`, like most terminals. zsh, bash and
Claude Code read `^H` as a plain backspace and ignore `CSI 3;5~`, so Windows/Linux users — whose muscle memory
says Ctrl+Backspace deletes a word — got one character or nothing. AutoHotkey remaps cannot fix it from outside:
they cannot tell the terminal from a text field in the same tab, and Ctrl+W is reserved by browsers.

## Decision
`getWordDeleteSequence` (`src/mainview/word-delete-keys.ts`), called from the custom key handler in
`TerminalView.tsx`, sends `^W` for Ctrl+Backspace and `ESC d` for Ctrl+Delete — the same pair VS Code's terminal
sends. `^W` beats `ESC DEL` because it also works in vim insert mode, where a leading ESC would leave insert mode.
It applies only off macOS (Option+Backspace is the word delete there) and only on a tmux stream.

## Risks
A program that binds Ctrl+Backspace distinctly (`^H`) no longer sees it inside tmux on Windows/Linux. The native
backend is untouched: Windows ConPTY already turns `^H` into a real Ctrl+Backspace key event for PSReadLine, and
the renderer cannot tell a native Linux host from a Windows one.

## Alternatives considered
`ESC DEL` (breaks vim insert mode); a per-user zsh `bindkey` (does not reach Claude Code); AutoHotkey in the
browser (breaks the app's own text fields, and Alt+D focuses Firefox's address bar).
