# A `+` new-window button inside the tmux status bar

## Context
Users asked for a clickable `+` beside the always-visible top tab bar. The bar is drawn by tmux itself, so an app overlay would have to guess where tmux put the tabs in cells, and a header/inspector button would only duplicate Cmd+T.

## Investigation
tmux 3.4 added user ranges (tmux `CHANGES`, 3.3a → 3.4): `#[range=user|<name>]` in a status format makes a click report `MouseDown1Status` with `#{mouse_status_range}` set to `<name>`. Content placed after `#[nolist]`, still in the left alignment, lands in tmux's "after the list" slot: when tabs overflow, the list is trimmed behind its `<`/`>` markers and the after-list content stays. Verified on isolated tmux 3.6a and 3.5a servers (attached client inside a throwaway outer server): the hit target is exactly the button's 5 cells, the gap cell before it is inert, tab clicks still switch.

## Decision
`src/bun/tmux/themes.ts` builds `STATUS_FORMAT` = tmux 3.6a's default `status-format[0]` verbatim + `#[nolist]` + `NEW_WINDOW_BUTTON`. `src/bun/tmux/config.ts` sets it and rebinds `MouseDown1Status` to `new-window -c PANE_CWD_FORMAT` when the click hit the `dev3-new-window` range, else tmux's default `switch-client -t =`. Same command and cwd rule as Cmd+T (`tmuxNewWindow`).

## Risks
- The default format is copied, so a future tmux that changes its default bar keeps the 3.6a one (3.5a differs only by `window_end_flag` vs `loop_last_flag`, invisible with our empty separator). On tmux before 3.4 the `+` would draw but do nothing (not run here).
- Both settings persist on the shared live server: removing them later needs explicit `set -gu 'status-format[0]'` and the default `MouseDown1Status` binding, not a deleted line.
- Rapid repeat clicks do not stack windows: the button moves right as each tab appears, and a second click within tmux's double-click window arrives as `DoubleClick1Status`.
- Seq 2060's navigator (unmerged) turns the bar off in task sessions; there the `+` disappears with it and the navigator needs its own new-window control.

## Alternatives considered
- `+` in `status-left` (fixed far-left spot, no format override): reliable but far from the tabs it creates.
- `+` in `status-right` beside the pane badge: same problem, mixes with a readout.
- App overlay button over the terminal: pixel-to-cell guessing and a second owner of the bar.
