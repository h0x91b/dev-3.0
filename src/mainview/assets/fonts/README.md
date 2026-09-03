# Bundled terminal fonts

The fonts the terminal font picker offers (Settings → Terminal). Fifteen of them are Nerd
Fonts: the Regular weight of that family's fixed-advance `NerdFontMono` face, converted to
woff2 from the [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1)
release. `JetBrainsMonoNerdFontMono-Bold.woff2` is the one bold face, because `font-mono`
uses that family for app chrome as well.

The `Propo` and non-`Mono` variants are deliberately absent: they are not fixed-advance and
cannot hold a terminal grid.

**`JetBrainsMono-Regular.woff2` is the exception — the only unpatched face here**, converted
from the upstream [JetBrains Mono v2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304)
release. A Nerd Font is a third-party patch that adds thousands of icon glyphs, and the
picker used to label the patched face "JetBrains Mono", so nobody could ask for the plain
typeface (issue #1625). Its metrics are byte-identical to the patched face — same
`unitsPerEm`, advance, ascent, descent, cap and x-height — so the two differ only in which
glyphs exist. Every stack still ends in the Nerd Font, so an icon the plain face lacks
falls through to it rather than rendering as a box.

**Replacing a file means re-measuring its width.** Every family carries a `scale` in
`src/mainview/terminal-font.ts` that keeps its cell inside the reference font's cell — see
`decisions/2026/08/25/terminal-font-width-is-clamped-to-the-reference.md`.

## Licenses

`licenses/<Family>.txt` is the upstream license for each bundled family, copied verbatim
from the Nerd Fonts repository at v3.5.1. All of them permit redistribution, and
`licenses/JetBrainsMono.txt` (SIL OFL 1.1) covers the unpatched face as well as the patched
one — it is the same upstream project:

| License | Families |
|---|---|
| SIL Open Font License 1.1 | JetBrains Mono, Fira Code, Fira Mono, IBM Plex Mono, Source Code Pro, 0xProto, Cascadia Mono, Cascadia Code, Iosevka, Iosevka Term |
| Apache-2.0 | Meslo LG, Droid Sans Mono |
| MIT | Hack (plus Bitstream Vera terms for the DejaVu work), Comic Shanns Mono |
| BSD-3-Clause | Go Mono |

| Family | Face bundled | License file |
|---|---|---|
| JetBrains Mono Nerd Font | `JetBrainsMonoNerdFontMono` (Regular + Bold) | `licenses/JetBrainsMono.txt` |
| JetBrains Mono (unpatched) | `JetBrainsMono-Regular` | `licenses/JetBrainsMono.txt` |
| Meslo LG S | `MesloLGSNerdFontMono` | `licenses/Meslo.txt` |
| Hack | `HackNerdFontMono` | `licenses/Hack.txt` |
| Fira Code | `FiraCodeNerdFontMono` | `licenses/FiraCode.txt` |
| IBM Plex Mono | `BlexMonoNerdFontMono` | `licenses/IBMPlexMono.txt` |
| Source Code Pro | `SauceCodeProNerdFontMono` | `licenses/SourceCodePro.txt` |
| 0xProto | `0xProtoNerdFontMono` | `licenses/0xProto.txt` |
| Cascadia Mono | `CaskaydiaMonoNerdFontMono` | `licenses/CascadiaMono.txt` |
| Droid Sans Mono | `DroidSansMNerdFontMono` | `licenses/DroidSansMono.txt` |
| Go Mono | `GoMonoNerdFontMono` | `licenses/Go-Mono.txt` |
| Comic Shanns Mono | `ComicShannsMonoNerdFontMono` | `licenses/ComicShannsMono.txt` |
| Cascadia Code | `CaskaydiaCoveNerdFontMono` | `licenses/CascadiaCode.txt` |
| Iosevka | `IosevkaNerdFontMono` | `licenses/Iosevka.txt` |
| Iosevka Term | `IosevkaTermNerdFontMono` | `licenses/IosevkaTerm.txt` |
| Fira Mono | `FiraMonoNerdFontMono` | `licenses/FiraMono.txt` |
