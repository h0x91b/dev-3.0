# 186 — A separate `--accent-fill` token for solid accent buttons

## Context

`bg-accent` + `text-white` is the app's primary button. Measured in the running
app, white on the dark-theme `--accent` (`69 150 254`) is **2.98:1** — below WCAG
AA 4.5:1 for 14px semibold text, and below even the 3:1 large-text allowance.
Light theme was 4.47:1, also short.

The obvious fix — darken `--accent` — does not work. That token is also the source
of `text-accent`, used **263 times** in the renderer for accent text and icons on
dark cards. Darkening it to pass AA behind white ink drops accent *text* on
`bg-raised` from 6.21:1 to 3.64:1, i.e. it trades one failing button for 263
failing labels.

## Decision

Added `--accent-fill` / `--accent-fill-hover` to both themes in
`src/mainview/index.css`, mapped as `bg-accent-fill` / `bg-accent-fill-hover` in
`tailwind.config.js`, and migrated every site that puts white ink on a solid
accent fill (73 lines across 47 files, found by `bg-accent` co-occurring with
`text-white`). `--accent` keeps its current value and its text/icon role.

Measured after the change: white on `--accent-fill` is **5.09:1** dark and
**5.32:1** light. The existing `--accent-hover` comment already stated the intent
("accent fills: deeper, keeps white ink readable") — it just was not deep enough,
and it was doing two jobs.

## Risks

Two accent fills now exist, so a new solid button could reach for the wrong one.
The guard is intent, not tooling: `bg-accent` for tints and text, `bg-accent-fill`
only where ink sits directly on the fill. `bg-accent/NN` tints are untouched and
still correct. There is no automated check.

## Alternatives considered

- **Darken `--accent`.** Rejected: regresses 263 `text-accent` sites (above).
- **Dark ink on the existing blue** (`--accent-ink`, near-black on dark theme).
  Reaches 7.05:1 and needs no fill change, but a blue button with black text does
  not match this app's visual language. Offered to the user; they chose the deeper
  fill.
- **Reuse `--accent-hover` as the resting fill.** Only 4.24:1 — still under AA,
  and it would leave hover with nowhere to go.
- **Leave it as a known debt.** Rejected: it is the primary action on most screens.
