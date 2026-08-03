# 196 — Shortcuts have a primary and an alias slot, and the iTerm2 preset is gone

## Context

Two problems left over from [decision 195](195-keymap-registry-drives-dispatch.md):

1. A shortcut's bindings were one flat `Binding[]`. "The second way to press it"
   was therefore an accident of list order — the editor could only render the
   whole list behind one control, and a user could not add or clear an
   alternative on its own.
2. The four ⌘-key pane shortcuts (⌘D / ⌘⇧D / ⌘W / ⌘T) lived in an opt-in
   **"iTerm2 compatibility"** preset with its own storage
   (`GlobalSettings.terminalKeymap` *and* a `localStorage` key), its own keymap
   table (`src/mainview/terminal-keymaps.ts`), and a checkbox in **three**
   surfaces: Settings, the ⓘ popover beside the terminal, and the native
   Terminal ▸ Keyboard Mode menu. The preset already defaulted to on, so it
   existed only to turn four shortcuts off — something the new editor does per
   row, one shortcut at a time.

## Investigation

- The preset's ⌘[ / ⌘] pane-navigation bindings **collided** with the app-level
  `back` / `forward` shortcuts. Both handlers sit on `window` in the capture
  phase and `App.tsx` registers first, so pressing ⌘[ in a focused terminal ran
  navigation *and* pane focus.
- That collision did not need a matcher rule to fix: `src/bun/tmux/config.ts`
  already binds `M-Left`/`M-Right`/`M-Up`/`M-Down` **prefix-free**, so ⌥+arrows
  have always switched panes at the tmux layer. The renderer bindings were
  redundant.
- `splitV` maps to tmux `split-window -h` (side-by-side), matching iTerm2's ⌘D.
  Names and actions were kept byte-identical so behavior did not drift.

## Decision

**Slots.** `ShortcutSpec` carries `primary: Binding[]` plus an optional
`alias?: Binding[]`, and `ShortcutOverrides` became
`Record<id, { primary?: string | null; alias?: string | null }>` — an absent slot
keeps its default, `null` was deliberately emptied. More than one entry in a slot
means mutually-exclusive **platform variants** (⌘- on macOS vs Ctrl+Alt+-
elsewhere), never an alias. `findConflict` reports `ownerSlot`, so stealing a
combo empties only the slot that held it.

**No preset.** Deleted `TerminalKeymapPreset`, `GlobalSettings.terminalKeymap`,
`src/mainview/terminal-keymaps.ts`, the Settings checkbox, the ⓘ popover block,
and the native **Terminal ▸ Keyboard Mode** menu. The four shortcuts are ordinary
registry rows in the `terminal` conflict group, dispatched by `TerminalView` only
while a terminal has focus. Pane navigation is **not** a registry row — tmux owns
it.

**One cheat sheet.** The ⓘ button now opens the ⌘/ overlay on its Terminal tab,
which leads with those four combos read from the registry (so it shows whatever
the user rebound them to). The partial hover popover it replaced is deleted.

## Risks

- A user who had explicitly opted out of the preset gets ⌘W/⌘D/⌘T back. Accepted
  deliberately (the user's call): the editor now lets them unbind each row
  individually, which the old checkbox could not do. It is in the changelog.
- Dropping `terminalKeymap` from `GlobalSettings` is safe for the shared
  `~/.dev3.0` directory: an older app reading a file without the field falls back
  to its `undefined ⇒ iterm2` default, which is the same behavior as the new one.
- `ShortcutOverrides` changed shape, but the field has never shipped, so no
  migration exists or is needed.

## Alternatives considered

- **Give pane navigation new keys** (⌥←/⌥→ was the first idea). Rejected on
  inspection: ⌥+arrows are already bound by tmux, so the right fix was to delete
  the renderer bindings, not to move them. As a renderer shortcut they would also
  have shadowed shell word-motion.
- **Let ⌘[ mean pane-focus while a terminal has focus**, teaching the matcher
  that a `terminal`-group shortcut outranks an `app` one. Rejected: a real rule
  with real blast radius, added to solve a collision that disappears once the
  redundant bindings go.
- **Keep the checkbox** and just make the four shortcuts rebindable. Rejected:
  two mechanisms for switching the same shortcuts off, in three places.
- **`primary: Binding` (a single binding, not a list).** Rejected: platform
  variants genuinely need two entries in one logical slot, and collapsing them
  would have forced a `{ mac, other }` wrapper into every entry.
