# 195 — The keymap registry drives dispatch, so shortcuts can be rebound

## Context

`src/mainview/keymap.ts` listed every app-level shortcut as data, but only as
*documentation*: the combos were also hand-written a second time as modifier
conditions in the `App.tsx` `useGlobalShortcut` if-else chain
([decision recorded in `docs/ux/UX_DECISIONS.md`, 2026-06-19](../docs/ux/UX_DECISIONS.md)).
A vitest test guarded the two copies against drift. That split made user
rebinding impossible: a new combo would have to be edited in two places, one of
them a 320-line conditional.

## Investigation

The chain held real, non-obvious behavior that a naive rewrite would lose:

- Some branches used `hasAppModifier` (⌘ on macOS, Ctrl elsewhere — platform-exact,
  because `⌃K`/`⌃Q`/`⌃N` belong to the shell), others used the loose
  `(e.metaKey || e.ctrlKey)`. The looseness was accidental, not designed.
- Some matched `e.code` (layout-independent), others `e.key` (not).
- Several shortcuts are not a combo at all: the `g …` chord sequences, the
  `⌘1–9` digit families, the hold-modifier task switcher, `Esc`.
- `⌘F` belongs to the terminal search *and* the artifact search, which never
  have focus at the same time.

## Decision

`keymap.ts` now carries machine-readable `defaults: Binding[]`
(`KeyboardEvent.code` + an exact modifier set, with `Mod` meaning ⌘/Ctrl), and
every handler condition became `matchesShortcut(e, "<id>")`
(`src/mainview/keymap-bindings.ts` for the grammar, `keymap-store.ts` for the
override layer). Display strings are derived — `shortcutKeysFor` formats the
bindings instead of reading a hand-written label.

Consequences, each deliberate:

- **`Mod` is strict everywhere.** The loose `(meta || ctrl)` branches are gone,
  so on macOS `⌃,` / `⌃=` / `⌃\`` reach the terminal instead of the app. The
  code comments already claimed this was the rule; now it is.
- **Structural shortcuts stay hand-written** and are marked `remappable: false`
  with a `fixedReasonKey`. They render read-only in the editor rather than being
  hidden.
- **`conflictGroup`** lets the terminal and artifact `⌘F` coexist.
- **The `g …` chord moved to the top of the handler**, ahead of every combo —
  otherwise `g` then `c` would create a task instead of cancelling the sequence.
- **`setKeymapCapture()`** suspends all dispatch while the settings recorder is
  open. Both listeners sit on `window` in the capture phase and the dispatcher
  registered first, so `stopPropagation` from the recorder is too late.
- Overrides live in `GlobalSettings.keyboardShortcuts`, sparse: only rows the
  user actually changed, so a changed default still reaches everyone else.

## Risks

- The strict-`Mod` change silently removes macOS `Ctrl` aliases some users may
  have found by accident. It is in the changelog; the terminal gets those keys
  back, which is the point.
- The dispatcher is now one function away from every shortcut. A bug in
  `matchesBinding` breaks all of them at once — hence
  `src/mainview/__tests__/keymap-bindings.test.ts` covering the matcher directly.
- `codeMatches` falls back to `e.key` when an event carries no usable `code`
  (`""`/`"Unknown"` — soft keyboards, some remote-desktop stacks). That path is
  layout-dependent by nature; it is a fallback, never preferred.

## Alternatives considered

- **Keep the two copies and add a third for overrides.** Rejected: three places
  to edit one combo, and the drift test cannot check behavior, only strings.
- **Rewrite the chain into a table-driven dispatcher** (one `Map<binding, action>`).
  Rejected: the per-branch guards (`showQuitDialog`, virtual projects, hint
  targets, `cycleVariant` returning false) are not uniform, so the table would
  need an escape hatch per entry and would read worse than the chain.
- **Make every shortcut remappable**, expressing chords and digit families in
  the binding grammar. Rejected: the grammar would grow a sequence type and a
  key-range type to serve four entries nobody asked to rebind.
