# Pane zoom and swap are app-level shortcuts, not new tmux bindings

## Context

Issue #1514 asked for hotkeys to zoom a pane and to swap panes, naming tmux's
`<Prefix> {` / `}` as the reference. The obvious reading is "add bindings to
`src/bun/tmux/config.ts`", which is where every `⌃B` key in dev3 lives.

## Investigation

Verified against the live dev3 tmux server (`tmux list-keys -T prefix`):

- `bind-key -T prefix z resize-pane -Z`
- `bind-key -T prefix { swap-pane -U`
- `bind-key -T prefix } swap-pane -D`

All three already exist — dev3's config never unbinds them — and all three are
already printed on the Keyboard Shortcuts overlay's Terminal tab
(`KeyboardShortcutsModal.tsx`). Zoom was also already implemented as a
backend-neutral action (`TaskPaneAction` kind `zoom`) on **both** the tmux and
the native backend. So on tmux the feature was fully present and documented.

What was actually missing: the **native** backend (no tmux, therefore no `⌃B`
prefix at all) had zoom but no swap, and neither backend had a prefix-free combo
— which is also the only route in remote/browser mode, where a `⌃B` chord is
awkward and the desktop menu bar is a React one.

## Decision

Zoom and swap were added as **app-level** entries in `src/mainview/keymap.ts`
(`pane-zoom`, `pane-swap-next`, `pane-swap-prev`), joining the existing
renderer-dispatched pane family (`pane-split-vertical`, `pane-close`, …). No
`tmux/config.ts` change at all. The boundary the repo already draws holds: a
combo the **renderer** intercepts and turns into an RPC is app-level and
rebindable; a combo **tmux itself** consumes behind its prefix is tmux's and only
gets documented. A binding added to `tmux/config.ts` would have been invisible to
the native backend and unreachable in the browser.

The one genuinely new backend capability is pane swap: `swapStep` in
`src/shared/task-panes.ts`, backed by `tmux.swapPaneStep` (`swap-pane -D/-U`,
verbatim what tmux's own `{` / `}` run) and by `swapPanes()` /
`neighbourPaneId()` in `src/shared/split-tree.ts` for native. It is advertised as
the `swap` capability so a backend without it is visibly disabled rather than
silently dead.

Defaults are `⇧⌘Enter` (zoom) and `⇧⌘,` / `⇧⌘.` (swap), reading as `<` and `>`.
`⇧⌘[` / `⇧⌘]` were rejected despite matching tmux's `{` / `}` most closely: the
app spends them on variant cycling, and because pane shortcuts live in the
`terminal` conflict group they would have shadowed it without any conflict
warning — a terminal holds focus most of the time in this app. A unit test in
`keymap.test.ts` now guards that specific mistake.

## Risks

- `swapPanes()` moves pane ids between positions and deliberately leaves
  `activePaneId` and `zoomedPaneId` alone; a future reader may mistake that for
  an oversight. Covered by a test asserting the active pane travels with its
  content.
- Two shortcut families now do the same thing on tmux tasks (`⌃B z` and
  `⇧⌘Enter`). That is intended parity, not duplication — the overlay lists both.

## Alternatives considered

- **Bind them in `tmux/config.ts`.** Rejected: dead on the native backend, and it
  would not have surfaced in the rebindable keymap or the browser menu bar.
- **Do nothing and close #1514 as already-shipped.** Honest for tmux, wrong for
  native and for remote — the two surfaces this board repeatedly gets burned by
  treating as one.
- **Rotate/marked-pane swap too** (the greyed-out `Swap with Marked` and rotate
  menu items). Left disabled: neither a marked pane nor rotation exists in the
  backend-neutral vocabulary, and inventing them was outside what was asked.
