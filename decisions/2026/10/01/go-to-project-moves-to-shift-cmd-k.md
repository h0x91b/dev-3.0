# Go to Project moves from ⌘K to ⇧⌘K

## Context

⌘K opened the Go to Project palette, caught app-wide before the terminal. Terminal users expect ⌘K to clear the
terminal, and the Terminal menu already advertised "Clear Scrollback Buffer ⌘K" (`term-clear-buffer`, still in
`NOT_YET_IMPLEMENTED`), so the menu promised one thing and the key did another. The user asked to free ⌘K.

## Investigation

Checked each candidate against `keymap.ts`, the native menu accelerators, the terminal-focus rule
(`isControlCharBinding`: plain Ctrl+<key> off-macOS always reaches the shell) and browser docs for remote mode.
⇧⌘K/Ctrl+Shift+K: free in the app; Firefox on Windows/Linux opens its Web Console on Ctrl+Shift+K. ⌘P: Add Project
and browser print. ⌘E: Chrome Win/Linux search, and Ctrl+E is a control char (dead in a focused terminal).
Whether a page can cancel the Firefox combo was not tested.

## Decision

`go-to-project` defaults to `Mod+Shift+K` (`src/mainview/keymap.ts`); the View menu label reads
`Go to Project… (⇧⌘K)`. No alias on plain ⌘K — it is left free; making it clear the terminal is a separate task.
User overrides (`GlobalSettings.keyboardShortcuts`) are untouched, so anyone who rebound the palette keeps their key.

## Risks

Muscle memory: ⌘K now does nothing until the clear-terminal task lands. Remote mode in Firefox on Windows/Linux may
open the Web Console instead of the palette; the rebind UI and ⇧⌘P → "Go to project" remain as escapes.

## Alternatives considered

⌘P (two shortcuts would move), ⌘E (conflicts listed above), no dedicated key (one extra step for a daily action),
keeping ⌘K (blocks the expected terminal clear).
