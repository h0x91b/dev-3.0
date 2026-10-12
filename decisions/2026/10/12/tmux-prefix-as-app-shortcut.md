# The tmux prefix and pane focus as rebindable app shortcuts

## Context
Users wanted pane focus on ⌘⌥[ / ⌘⌥] and the tmux prefix on ⌘A. tmux receives bytes from the terminal and Command never becomes a byte, so `set -g prefix` cannot name a ⌘ key. A Karabiner remap works only per app, which takes ⌘A (Select All) away from every dev3 text field too.

## Decision
`tmux-prefix` in `src/mainview/keymap.ts` is a terminal-group shortcut: `TerminalView`'s capture-phase pane handler sends `\x02` (tmux's unchanged default prefix) down the PTY socket, and only when focus is inside a tmux terminal (`tmuxStreamRef`). Native sessions have no prefix, so the key is left alone there. `pane-focus-left/right/up/down` reuse the existing `focusDirection` pane action on tmux; on native, focus is client-local (`TaskTerminal`), so the host walks the split tree with `focusPane()` via the `onFocusDirection` prop instead of moving the server's active pane.

## Risks
If the dev3 tmux config ever changes the prefix, `TMUX_PREFIX` in `TerminalView.tsx` must follow. ⌘⌥←/→ is Chrome's tab switch on macOS, so those defaults are `desktopOnly` with a ⌥⇧ browser alternative.

## Alternatives considered
Making the real tmux prefix configurable: still cannot reach ⌘. Translating the focus keys into tmux's ⌥⇧+arrow escape sequences: would not work on the native backend.
