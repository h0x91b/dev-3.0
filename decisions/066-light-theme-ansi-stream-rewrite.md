# Light theme: rewrite pale ANSI colors in the PTY stream

## Context

In the light theme, Claude Code output was unreadable: removed diff lines, file paths, and spinners washed out on the white background. Captured SGR codes via `tmux capture-pane -e`: pale 256-color indexes (`38;5;183`, `38;5;226`, `38;5;51`, `38;5;114`) and `SGR 2` (dim) on `37` (white).

## Investigation

ghostty-web's `ITheme` only covers the 16 ANSI colors; 256-color indexes are resolved to RGB inside the WASM terminal, so the theme palette cannot remap them. Dim is rendered as `globalAlpha = 0.5`, which on a white background blends even pure black to `#808080`+ — removed diff lines (`2;37`) were hopeless regardless of palette values.

## Decision

Added `src/mainview/utils/ansi-light-adapt.ts` — a stateful stream filter applied in `TerminalView.tsx` (`enqueueTermWrite` flush) only when the light theme is active. It drops standalone `SGR 2`, and rewrites pale foregrounds (`38;5;N` with N≥16, `38;2;R;G;B`) whose relative luminance exceeds 0.55 to a darkened truecolor (~0.42 luminance). Sequences split across WS chunks are carried over to the next flush. Also darkened `LIGHT_TERMINAL_THEME` entries (white, brightBlack, yellow, brightYellow) to GitHub Primer light fg values.

Darkening `white` created a follow-up conflict: Claude Code's light-ansi theme paints message bars with `ansi:white` as a *background* (`SGR 47`) and dark fg (30/90) on top — a dark-on-dark bar. The filter therefore splits the roles of index 7/15: as text (37/97) they stay dark, as backgrounds (47/107, 48;5;7, 48;5;15) they are rewritten to light gray truecolor (220/240), matching Claude Code's own non-ansi light theme bar colors.

## Risks

Dropping dim loses the muted-vs-normal distinction in light mode (diff add/remove still differ by their red/green markers). Colors written while one theme is active stay resolved in scrollback after a theme switch until the app repaints. Backgrounds are intentionally untouched — darkening pale backgrounds would invert intent.

## Alternatives considered

- Remapping via theme palette: impossible for 256-color indexes (resolved in WASM).
- OSC 4 palette redefinition: not supported by ghostty-web.
- Stateful dim→blended-color emulation (tracking fg across sequences): better fidelity but significantly more complex; dropping dim is predictable and readable.
