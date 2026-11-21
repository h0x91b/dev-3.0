# Terminal window tab decorations on an internal `terminalTabDecorations` slot

## Context
This is Phase 8, PR 2 of the GUI-on-plugins plan (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`),
the "pane-header decorations" item.

On desktop, the only pane header React draws is the window tab row above the terminal (`TerminalWindowNav`).
tmux draws the pane title bars itself (`pane-border-format`). Those stay host-owned, along with the rest of the
tmux layout.

The slot is internal: no manifest kind, no public service, no API version bump.

## Decision
- **Registry.** `src/mainview/terminal-tab-decorations/` holds a contribute-kind registry. An item is a passive
  glyph after a window tab's name. Its `when(scope)` and `label(t, scope)` receive `{ window, unseen }`.
- **Accessible name.** Each label is folded into the tab's accessible name and tooltip detail. It goes where the
  bell/new-output text sat before: after the home state, before the pane count. The glyph is `aria-hidden`.
- **Built-in.** `builtin:window-activity` is the former `WindowMarker`. It applies whenever the window rang a bell
  or has unseen output, so the active tab still says "bell" in its name but draws no dot. Byte-identical to before.
- **Host-owned, unchanged:**
  - the leading ✦/index glyph, which swaps with the rename pencil;
  - rename, close and `+`;
  - the narrow window switcher;
  - tmux pane borders.
- **Budget.** Every built-in, then at most one extension decoration per tab, inside the tab's existing
  `max-w-[14rem]`. The row never grows.
- **Isolation.**
  - A throwing `when` or `label` hides the decoration.
  - A crashing component is dropped by its own boundary and then stops being placed. The block is keyed by the
    registered object, so a reloaded extension retries.
  - Each failure is logged once per id and callback, never per tab or per poll (the review-2394 W1/W2 trap).
- **Hot path.** WindowTabs subscribes to the registry once. When the row renders, each tab loops over a stable
  snapshot. The terminal's input and paint path never touches it.

## Risks
- The scope hands an extension the raw `TmuxWindowEntry`. That is fine internally, but it is not yet a public contract.
- A crashed decoration's label stays in the tab's name until the row next renders, which is the next window poll.

## Alternatives considered
- **Decorating tmux pane borders.** tmux renders them, so this would mean changing the tmux layout, which stays host-owned.
- **A wrapper span around every decoration.** It changes the built-in's DOM and the gap rhythm, for no gain.
