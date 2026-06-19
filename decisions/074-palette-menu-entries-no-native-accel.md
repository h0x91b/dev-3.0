# 074 — Palette entries in the View menu carry no native accelerator

## Context

The Cmd+K project quick-switch and Cmd+Shift+P command palette shipped as
renderer keydown handlers (`App.tsx`) but were missing from the native menu, so
they were undiscoverable for mouse users. We wanted them in the application menu
without breaking the existing shortcuts.

## Decision

Added two items to the top of `viewMenu()` in
[src/bun/application-menu.ts](../src/bun/application-menu.ts):
`Go to Project… (⌘K)` → `open-project-switch` and
`Command Palette… (⇧⌘P)` → `open-command-palette`. Both route through
`handleMenuAction` (`menuRouter.ts`) which dispatches a `menu:open-*`
CustomEvent that `App.tsx` listens for and **opens** (not toggles) the palette.

Neither item gets a native `accelerator`. The chord is shown in the label text
instead.

## Risks

- The shortcut is embedded in the label rather than the native right-aligned
  column, so it looks slightly non-native. Acceptable: the menu only renders on
  macOS (Electrobun has no Linux menu), and label text is the only way to show a
  chord we can't bind.

## Alternatives considered

- **Native `accelerator` field** — rejected. Electrobun menu accelerators only
  support single characters, not chords like `Shift+P` (see decision 044).
  Cmd+Shift+P simply can't be bound. And the palettes *toggle* (`o => !o`); a
  native accelerator on Cmd+K would either double-fire with the keydown handler
  or prevent closing via the same chord. Keeping the keydown handler as the sole
  shortcut owner avoids both.
- **No shortcut shown (New Window precedent)** — rejected. The whole point was
  discoverability of the shortcut, so the label hint earns its keep.
