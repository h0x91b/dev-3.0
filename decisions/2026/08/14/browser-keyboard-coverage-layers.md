# Full keyboard coverage in browser remote mode

## Context

The keymap was designed on macOS, where the app modifier is ⌘ and nothing else wants it. `Mod`
translates to `Ctrl` off macOS — and the app's main content is a terminal, where `Ctrl` combos are
control characters. Reported from the field: `Ctrl+D` in a remote terminal on Windows split a pane
instead of sending end-of-file. A browser adds a second claimant on top: ⌘W/⌘T/⌘N/⌘1–9/zoom/F11
cannot be cancelled from a page.

## Investigation

`App.tsx` dispatches on `window` in the capture phase with `preventDefault` + `stopPropagation`, and
`isTypingContext()` was consulted only for bare-key bindings (`isBareKeyBinding`). Every modifier
binding therefore fired while a terminal had focus. Eleven control characters were affected,
including `Ctrl+[` (Escape) bound to Back and `Ctrl+K` (kill-line) bound to the project switcher.

## Decision

Four layers, in `keymap-bindings.ts`, `keymap.ts`, `keyboard-lock.ts`:

1. `MatchContext` gained `terminal`; `matchesBinding` refuses any binding that resolves to a plain
   `Ctrl+<key>` while a terminal has focus (`isControlCharBinding`).
2. Terminal-group defaults are platform-split: ⌘-based on macOS, `Ctrl+Shift` elsewhere
   (`Ctrl+Shift+E`/`O`/`W`/`T`/`F`), matching gnome-terminal and Terminator.
3. Browser-owned combos are `desktopOnly` with a `remoteDisplay` alternative (`G then 0`, `⌃B x`),
   and the command palette gained `Mod+Shift+Space` — one key that survives every browser and
   terminal, which makes every action reachable because every action is a command.
4. `keyboard-lock.ts` calls `navigator.keyboard.lock()` while the document is fullscreen in remote;
   `MatchContext.keyboardLocked` then revives `desktopOnly` bindings, so the desktop keymap works
   verbatim. `Escape` is never locked, so one press still leaves fullscreen.

`slotBindings` now maps a user override back onto the matching default object, because a stored
override carries only a combo and would otherwise strip `desktopOnly` from a re-recorded default.

## Risks

Chromium-only for layer 4; Safari and Firefox stay on layers 1–3. The Linux terminal defaults changed
for existing users — an override survives, but a muscle-memory ⌘D does not. `Ctrl+Shift+W/T` are
browser-owned, so those two are `desktopOnly` even on Linux and remote users need `⌃B`.

## Alternatives considered

An `Alt`-based scheme (Alt is Meta to readline and the menu key on Windows). Keyboard Lock alone
(leaves Safari and Firefox with nothing). Chords for everything (dead while a terminal has focus,
which is most of remote usage). A PWA install (already ruled out in `fullscreen.ts`: the serving
origin changes per launch).
