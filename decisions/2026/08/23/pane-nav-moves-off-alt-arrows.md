# Prefix-free pane navigation moves to Alt+Shift+arrow

## Context

`src/bun/tmux/config.ts` bound `M-Left/Right/Up/Down` in tmux's **root** table
(`bind -n`), so Alt+arrow switched panes without the `⌃B` prefix. A root-table
binding is consumed by tmux and never reaches the pane, which took modifier+arrow
word motion away from the shell and from agent TUIs — the motion is used far more
often than directional pane switching. [decision
2026/08/03](../03/shortcut-slots-and-no-iterm2-preset.md) had already noted that a
*renderer* binding on ⌥+arrows "would have shadowed shell word-motion"; the tmux
binding was doing exactly that all along.

## Investigation

- tmux 3.6a's own defaults bind arrows only under the **prefix** table
  (`⌃B ←` select-pane, `⌃B M-←` / `⌃B C-←` resize). Nothing binds Ctrl+arrow or
  Alt+arrow prefix-free — dev3's four lines were the only prefix-free arrow keys.
- ghostty-web's WASM encoder emits a distinct sequence for every arrow modifier
  combo, so Alt+Shift is addressable: `CSI 1;3 D` = Alt, `CSI 1;4 D` = Alt+Shift,
  `CSI 1;5 D` = Ctrl, `CSI 1;7 D` = Ctrl+Alt.
- Verified end to end through a real PTY into tmux 3.6a with this config:
  `CSI 1;4 D` / `CSI 1;4 C` move the active pane left/right, and `CSI 1;3 D`
  (plain Alt+Left) now arrives in the pane as literal `^[[1;3D`.
- Ctrl+Alt+arrow was rejected as the replacement: GNOME uses it for workspace
  switching and some Windows graphics drivers rotate the screen with it.

## Decision

`TMUX_CONFIG_FUNCTIONAL` now binds `M-S-Left/Right/Up/Down` to `select-pane` and
explicitly `unbind -n`s the four `M-*` keys. The unbinds are load-bearing:
`configureTmux` re-sources this config into a **live** server, where a merely
deleted `bind` line stays in effect (same trap already documented for the
mouse-copy binding just below it). Guarded by
`src/bun/tmux/__tests__/config.test.ts`. `⌃B` + arrows (tmux's default) is
unchanged and still works.

## Follow-up: freeing the key was not enough

Freeing Alt+arrow only helps if something binds it. Measured on this machine:

- zsh binds **neither** `^[[1;3x` (Alt+arrow) nor, by default, `^[[1;5x`
  (Ctrl+arrow) — `zsh -f` has zero bindings for either. The user's own `.zshrc`
  happened to bind the Ctrl form via a plugin.
- macOS claims Ctrl+arrow **system-wide**: `com.apple.symbolichotkeys` IDs 79 and
  81 ("move left/right a space") are enabled with keycodes 123/124 + control, so
  the key never reaches any application.
- tmux is innocent for the Ctrl form: fed `CSI 1;5 D` through a real PTY into
  tmux running this config, the inner app receives `^[[1;5D` intact.

So `src/bun/shell-init.ts` now binds `^[[1;3x` **and** `^[[1;5x` to
`backward-word` / `forward-word` for zsh and bash, after sourcing the user's own
config. Alt+arrow is the combo that survives the OS; the Ctrl form is bound too,
for machines where the space-switch shortcuts are off.

## Risks

- Muscle memory: existing users lose Alt+arrow pane switching. Mitigated by the
  Keyboard Shortcuts overlay (Terminal tab now lists `⌥⇧` + arrows) and the
  changelog.
- Alt+Shift+arrow is word-*selection* in some GUI text fields; inside a terminal
  grid nothing else claims it, and no shell or agent TUI binds `CSI 1;4 x`.

## Alternatives considered

- **Ctrl+Alt+arrow** — rejected, see above (OS-level conflicts on Linux/Windows).
- **Drop prefix-free navigation entirely** and rely on `⌃B` + arrows. Rejected:
  the fix is a modifier change, not a feature removal, and the prefix-free combo
  is what makes a two-pane split usable one-handed.
- **Ctrl+Shift+arrow** — rejected: many terminal emulators already treat it as
  select-by-word, so it trades one collision for another.
