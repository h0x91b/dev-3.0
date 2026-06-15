# Theme-adaptive ANSI color rewrite in the PTY stream

## Context

In the light theme, Claude Code output was unreadable: removed diff lines, file paths, and spinners washed out on the white background. Captured SGR codes via `tmux capture-pane -e`: pale 256-color indexes (`38;5;183`, `38;5;226`, `38;5;51`, `38;5;114`) and `SGR 2` (dim) on `37` (white). The mirror problem appeared in the dark theme with Codex: it emits GitHub-light syntax truecolors (`38;2;51;51;51`, `38;2;24;54;145`, `38;2;167;29;93`) regardless of the terminal background — the terminal answers Codex's OSC 11 background query correctly (verified), Codex simply does not adapt.

## Investigation

ghostty-web's `ITheme` only covers the 16 ANSI colors; 256-color indexes are resolved to RGB inside the WASM terminal, so the theme palette cannot remap them. Dim is rendered as `globalAlpha = 0.5`, which on a white background blends even pure black to `#808080`+ — removed diff lines (`2;37`) were hopeless regardless of palette values.

## Decision

Added `src/mainview/utils/ansi-theme-adapt.ts` — a stateful stream filter applied in `TerminalView.tsx` (`enqueueTermWrite` flush) with the resolved theme as mode. Light mode: drops standalone `SGR 2`, rewrites pale foregrounds (`38;5;N` with N≥16, `38;2;R;G;B`) whose relative luminance exceeds 0.55 to a darkened truecolor (~0.42 luminance). Dark mode: keeps dim, brightens foregrounds below 0.25 luminance by blending toward white (~0.38 target; blend handles pure black without division by zero). Sequences split across WS chunks are carried over to the next flush. Also darkened `LIGHT_TERMINAL_THEME` entries (white, brightBlack, yellow, brightYellow) to GitHub Primer light fg values.

Darkening `white` created a follow-up conflict: Claude Code's light-ansi theme paints message bars with `ansi:white` as a *background* (`SGR 47`) and dark fg (30/90) on top — a dark-on-dark bar. The filter therefore splits the roles of index 7/15 in light mode: as text (37/97) they stay dark, as backgrounds (47/107, 48;5;7, 48;5;15) they are rewritten to light gray truecolor (220/240), matching Claude Code's own non-ansi light theme bar colors.

Foreground adjustment in both modes is gated by cross-sequence state, but the gate is luminance-aware, not binary: explicit truecolor/indexed backgrounds are classified by relative luminance (dark < 0.35, light > 0.55, mid-tones unknown). Foregrounds pass through untouched only when the active background's polarity is *opposite* to the theme (vim themes, selection bars — the app picked that fg for that bg) or unknown (named ANSI bgs 40-46/100-106 resolve theme-side, reverse video SGR 7). Same-polarity backgrounds keep fg adjustment on: Codex paints its entire UI on an explicit dark bg (`48;2;30;30;46`, Catppuccin base) and writes its model name with `38;2;0;0;0` on top — with a binary gate that black stayed black. The gate state persists across chunk boundaries.

White backgrounds get the same role-split in dark mode, mirrored: Claude Code paints message bars and the history-select highlight with `ansi:white`/`ansi:whiteBright` (47/107, `userMessageBackground`/`…Hover` in cli.js), which the dark palette resolves to pale lavender (#a9b1d6/#c0caf5) — default-fg text on it is unreadable. They are remapped to Claude Code's own dark theme bar colors (55/70 gray). Because Claude draws dark fg (30/90) on those bars (emitting fg *before* bg), the filter tracks the last dark ANSI fg across sequences and flips it to light gray when a white bar opens (and when 30/90 is set while one is active). Remapped white bars do not gate fg adjustment — after remapping they sit near the theme background, so the normal pale/dark fg fix stays correct on them.

The fg-before-bg ordering bites beyond white bars: Claude Code's status-line branch pill emits `38;5;16` (pure black) and only then `48;5;37` (teal, mid-luminance → gate "unknown"), so the dark-mode filter had already brightened black to gray before the gating bg arrived — gray-on-teal. The filter now keeps the *original* params of the last adjusted extended fg until any text is drawn (tracked via match offsets in the chunk filter, persisting across chunk boundaries); when a bg or reverse video that gates fg adjustment opens first, the original fg is re-emitted right after it, restoring the app's intended contrast.

Dim turned out to hurt the dark theme too, not just light. ghostty renders SGR `2` as 50% alpha; Claude Code's select-prompt (`AskUserQuestion`/plan) draws option descriptions, the leading numbers, the separators and the footer hints with Ink `dimColor` (verified in `cli.js`: those rows are `dimColor:!0` over the default fg). At 50% alpha the default dark-theme fg (`#c0caf5`) collapses to a low-contrast blue-gray — unreadable. Dim is now dropped in *both* modes (it was kept in dark originally), making the filter symmetric.

## Risks

Dropping dim loses the muted-vs-normal distinction in both themes — in dark mode the select-prompt option labels and their descriptions now render at the same brightness (readability over hierarchy; diff add/remove still differ by their red/green markers). Colors written while one theme is active stay resolved in scrollback after a theme switch until the app repaints. Light-mode pale backgrounds are intentionally untouched — darkening them would invert intent. The gate only sees SGR; an app that sets a background via OSC or DEC private modes would not trip it (not observed in practice).

## Alternatives considered

- Remapping via theme palette: impossible for 256-color indexes (resolved in WASM).
- OSC 4 palette redefinition: not supported by ghostty-web.
- Stateful dim→blended-color emulation (tracking fg across sequences): better fidelity but significantly more complex; dropping dim is predictable and readable.
- Asking Codex to adapt (it queries OSC 11 and gets a correct dark reply): upstream behavior we cannot control; symptom must be fixed on our side.
