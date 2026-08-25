# Bundled terminal fonts

The 15 Nerd Fonts the terminal font picker offers (Settings → Terminal). Each file is the
Regular weight of that family's fixed-advance `NerdFontMono` face, converted to woff2 from
the [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1)
release. `JetBrainsMonoNerdFontMono-Bold.woff2` is the one bold face, because `font-mono`
uses that family for app chrome as well.

The `Propo` and non-`Mono` variants are deliberately absent: they are not fixed-advance and
cannot hold a terminal grid.

**Replacing a file means re-measuring its width.** Every family carries a `scale` in
`src/mainview/terminal-font.ts` that keeps its cell inside the reference font's cell — see
`decisions/2026/08/25/terminal-font-width-is-clamped-to-the-reference.md`.

## Licenses

`licenses/<Family>.txt` is the upstream license for each bundled family, copied verbatim
from the Nerd Fonts repository at v3.5.1. All fifteen permit redistribution:

| License | Families |
|---|---|
| SIL Open Font License 1.1 | JetBrains Mono, Fira Code, Fira Mono, IBM Plex Mono, Source Code Pro, 0xProto, Cascadia Mono, Cascadia Code, Iosevka, Iosevka Term |
| Apache-2.0 | Meslo LG, Droid Sans Mono |
| MIT | Hack (plus Bitstream Vera terms for the DejaVu work), Comic Shanns Mono |
| BSD-3-Clause | Go Mono |

| Family | Face bundled | License file |
|---|---|---|
| JetBrains Mono | `JetBrainsMonoNerdFontMono` (Regular + Bold) | `licenses/JetBrainsMono.txt` |
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
