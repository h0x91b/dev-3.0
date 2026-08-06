# 184 — Split accent hover into `--accent-hover` (fills) and `--accent-emphasis` (text)

## Context

`--accent-hover` served two roles that pull in opposite directions on a dark
theme: the hover state of a filled accent button (`bg-accent text-white`, ~190
call sites) and the hover state of accent text or icons (`text-accent`, 25 call
sites). A single value cannot satisfy both — a filled button wants a *deeper*
accent so the white ink keeps its contrast, while accent text wants a *lighter*
accent so pointing at a link makes it easier to read, not harder.

## Investigation

Measured with APCA against the real kanban card surface (glass over the
background gradient), dark theme, before this change:

| Pair | Lc |
|---|---|
| `text-accent` (idle) | 44 |
| `text-accent-hover` (hover) | **32** — hover *lost* 12 Lc |
| white ink on `bg-accent` | 61 |
| white ink on `bg-accent-hover` | 74 |

So the token was correct for the fill role and backwards for the text role.
Raising its lightness to fix links would have dropped white-on-button from 74 to
about 53, which is below the Lc 60 floor for button labels.

## Decision

Two tokens with one meaning each (`src/mainview/index.css`, mapped in
`tailwind.config.js` as `accent.hover` / `accent.emphasis`):

- `--accent-hover` — hover for accent **fills**. Deepens in both themes.
- `--accent-emphasis` — hover for accent **text and icons**. Lifts on dark
  (`oklch(0.79 …)`, Lc 64), deepens on light (Lc 73).

Every `hover:text-accent-hover` was rewritten to `hover:text-accent-emphasis`.
`--success-hover` had the same conflict at a much smaller scale (1 fill site, 3
text sites); rather than add a third token, the three text sites dropped their
colour change and now rely on the `hover:bg-success/15` tint they already had.

## Risks

A third accent token is one more thing to pick correctly. Mitigation: the rule is
stated in `DESIGN.md` next to the table — `-hover` for fills, `-emphasis` for
text — and `--accent-hover` no longer appears in any `text-*` utility, so the
wrong choice is visible in review.

## Alternatives considered

- **Keep one token, split the difference** (`oklch(0.72 …)`): both roles land
  around Lc 52, i.e. both mediocre. Rejected.
- **Chroma-only hover** (same lightness, more chroma) would have fixed both roles
  at once, but the dark accent already sits on the sRGB gamut edge at
  `oklch(0.674 0.175 256)` — there is no chroma headroom.
- **Dark ink on a brighter accent fill** for buttons: works numerically, but
  inverts the ink colour of ~190 buttons and reads as a different design.
