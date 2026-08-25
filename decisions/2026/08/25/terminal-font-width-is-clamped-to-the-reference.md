# Terminal font width is clamped to the reference font, never above it

## Context

dev3 now bundles the 15 most-installed Nerd Fonts (issue #1511) instead of only
JetBrainsMono. They do not share a cell width. Measured from the shipped woff2 files
as advance-width-of `M` over `unitsPerEm`, the spread is 24%: Iosevka and Iosevka Term
sit at 0.500 em, Comic Shanns at 0.550, Cascadia at 0.586, JetBrains at 0.600, Fira
Code at 0.615, 0xProto at 0.620.

A user picks a font size once, by eye, against the terminal they already work in.
A font that renders *wider* silently takes columns away from every terminal they have
open — wrapped prompts, broken box drawing, a diff that no longer fits. A font that
renders narrower only gives columns back.

## Investigation

Live canvas measurement in the running app agrees with the font tables: at 72px,
JetBrains measures 43.20px per cell, Fira Code 44.31 (+2.6%), 0xProto 44.64 (+3.3%).
Nine of the fifteen are already at or below the reference. Only six need anything, and
four of those by less than 0.05%.

## Decision

**JetBrainsMono Nerd Font Mono is the reference width** (`REFERENCE_TERMINAL_FONT`,
`src/mainview/terminal-font.ts`). Every other font carries a `scale` that brings its
cell to at most the reference cell, and the rule is **one-directional** — a narrower
font is left alone rather than blown up to fill the cell, because that would change
what the user chose.

- Bundled fonts carry a measured constant in `BUNDLED_TERMINAL_FONTS`.
- A font the user typed is measured against the reference at runtime and cached
  (`terminalFontScale`), so a locally installed font obeys the same rule.
- Unmeasurable means `1`. Never guess a shrink.
- `effectiveTerminalFontSize()` is what reaches ghostty, via `scaledTerminalFontSize()`
  in `TerminalView.tsx`; rounding happens last so the trim is not lost to it.

Settings shows the consequence rather than hiding it: the entry says a font was
narrowed and by how much, and each gallery row carries the same figure.

## Risks

- **The constants are measured, not derived at build time.** Replacing a woff2 without
  re-measuring leaves a stale number. The guard test only proves the table is
  self-consistent (every scale ≤ 1), not that it still matches the bytes on disk.
- Fonts trimmed by ~0.03% (Droid Sans Mono, Go Mono) are scaled by an amount no one can
  see. Harmless, and dropping them from the rule would need a threshold nobody asked for.
- The percentage is rounded to one decimal before display, so a real but sub-0.05% trim
  shows no chip at all. Deliberate: "0% narrower" is noise.

## Alternatives considered

- **Do nothing and let each font render at its natural width.** Rejected: this is the
  failure the rule exists to prevent, and it is invisible until a terminal wraps.
- **Normalize in both directions**, scaling narrow fonts up to the reference cell.
  Rejected: someone choosing Iosevka is usually choosing it *because* it is narrow.
- **Measure every font at runtime instead of baking constants.** Rejected for the
  bundled set: it makes the first terminal's cell metrics depend on an async
  measurement, and the files are pinned in the repo. Kept for typed fonts, where there
  is no constant to read.
