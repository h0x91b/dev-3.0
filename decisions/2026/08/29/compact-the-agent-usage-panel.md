# Compact the agent usage panel

## Context

`decisions/2026/08/29/default-account-switch-lives-in-the-usage-flyout.md` turned the header
rate-limit tooltip into a panel that lists **every** Claude and Codex account, not just the ones
with a reading. The card design was inherited from the old tooltip, which never showed more than
a couple of cards. With nine accounts the panel measured 840px against a 448px flyout — the user
saw a scrollbar, half the accounts below the fold, and a 46px sticky "Account settings" button
eating the bottom of a panel that was already short of room.

## Investigation

Two rendering bugs made it worse, both invisible in Chromium:

- Every usage bar inside a card rendered at ~40% width in the desktop app. The card is a
  `<button>` with `display: flex; flex-direction: column`, and WebKit's UA stylesheet sets
  `align-items: flex-start` on `button` — so each row shrank to its own text width. Chromium does
  not, which is why the browser QA pass showed full-width bars.
- `AccountCardHeader` held the workspace name at its natural width (`whitespace-nowrap shrink-0`),
  so a long one pushed the plan and "Default" chips past the panel's `overflow-x-hidden` edge
  instead of eliding.

## Decision

Density, not fewer facts — nothing was dropped from the panel.

- `WindowBarRow` (`src/mainview/components/rate-limit-ui.tsx`) is one dense
  `label · bar · % · resets in` line, the same grammar the launch account picker already uses.
- Capture age rides the last quota line as a `· 15h` suffix (`CapturedAgeSuffix`); the standalone
  `CapturedNote` is deleted. `hasQuotaLines()` puts the age on the headline for a reading with
  nothing to plot (an unlimited account).
- An account with no reading says "no recent data" on its headline instead of on a second line.
- `ACCOUNT_CARD_CLASS` carries an explicit `items-stretch`, and the panel container uses `p-1.5`
  so the cards' `rounded-md` is concentric with the flyout's `rounded-xl`.
- The sticky footer button is gone; "Account settings" is a text link sharing the panel's header
  row with the hint, whose copy shrank to one line in all three locales.

Measured on a nine-account board: 840px → 425px, no scrollbar.

## Risks

The WebKit fix is verified by geometry, not by running WebKit — browser QA here is Chromium, where
the bug never reproduced. `items-stretch` is the correct explicit value in every engine, so the
worst case is that it fixes nothing rather than that it breaks something.

## Alternatives considered

Raising `HeaderFlyoutPanel`'s `maxHeight` — it is shared with the memory-headroom readout, and a
taller panel still wastes the same space per account. Hiding accounts with no reading behind a
"show all" toggle — the panel exists to compare accounts, and the switchable set must be visible
to be switchable.
