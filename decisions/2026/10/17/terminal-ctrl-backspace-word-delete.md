# Ctrl+Backspace / Ctrl+Delete delete a word in tmux terminals

## Context
ghostty-web encodes Ctrl+Backspace as `^H` and Ctrl+Delete as `CSI 3;5~`, like most terminals. zsh, bash and
Claude Code read `^H` as a plain backspace, and through tmux the unknown `CSI 3;5~` was worse than ignored: zsh
inserted `;5~`, bash `5~`, and vi-mode shells read the ESC as "leave insert" and `~` toggled case. Windows/Linux
users, whose muscle memory says Ctrl+Backspace deletes a word, got one character or junk.

## Investigation
An isolated tmux 3.6a server with dev3's key settings, fed the browser's exact bytes through an attached client,
showed that a browser-side `Ctrl+Delete → ESC d` (VS Code's choice) fixes shells but regresses neovim: neovim
decoded `<C-Del>` correctly before (one char forward, stays in insert) and `ESC d` leaves insert mode with `d`
armed, so the user's typing turns into normal-mode commands. The browser cannot see which program tmux shows.

## Decision
Ctrl+Backspace is translated in the renderer: `getWordDeleteSequence` (`src/mainview/word-delete-keys.ts`), called
through `getTerminalKeyOverride` from `TerminalView.tsx`, sends `^W` off macOS on a tmux stream only. `^W` beats
`ESC DEL` because it also works in vim/neovim insert mode. Ctrl+Delete is left to ghostty and decided by tmux,
which knows the pane's screen: `bind -n C-DC if -F '#{alternate_on}' 'send-keys C-DC' 'send-keys M-d'` in
`TMUX_CONFIG_FUNCTIONAL` (`src/bun/tmux/config.ts`). Shells get `M-d` (Claude Code reads `ESC d` as forward word delete); full-screen programs get
the raw key. The binding is server-side, so it applies to macOS clients too.

## Risks
`^W` still reaches full-screen programs: kill-region in emacs, search in nano, a window command in vim normal
mode. bash's `^W` stops at whitespace, not punctuation. vi-mode shells still corrupt the line on Ctrl+Delete
(`M-d` leaves insert mode), as they already did before. A TUI that does not use the alternate screen and does not
know `M-d` gets nothing useful. The native backend is untouched: ConPTY already turns `^H` into Ctrl+Backspace for
PSReadLine, and the renderer cannot tell a native Linux host from a Windows one, so Linux native users keep the
old keys. Before the first output frame of a (re)connect the renderer cannot know the stream is tmux, so `^H` goes out.

## Alternatives considered
`ESC d` from the browser for Ctrl+Delete (regresses neovim, see Investigation); `ESC DEL` for Ctrl+Backspace
(breaks vim insert mode); a per-user zsh `bindkey` (does not reach Claude Code); AutoHotkey in the browser (breaks
the app's own text fields, and Alt+D focuses Firefox's address bar); a distinct client sequence for Ctrl+Backspace
so tmux could gate it on `#{alternate_on}` too (would lose the vim/neovim insert-mode word delete `^W` gives).
