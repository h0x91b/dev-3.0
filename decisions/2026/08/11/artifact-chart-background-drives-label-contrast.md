# Artifact charts declare their card surface as `backgroundColor`

## Context

Value labels in dev3 artifact charts rendered as dark grey glyphs wrapped in a fat white halo. On the light theme nobody noticed — the halo is invisible on a white card. On the dark theme every number on a bar chart looked broken. The artifact shell had deliberately set `backgroundColor: "transparent"` in the registered `dev3` ECharts theme so the card surface would show through.

## Investigation

Reproduced with the pristine starter plus one horizontal bar chart with `label: { position: "right" }`, then read the emitted SVG in a headless browser. Labels came out `fill="#333" stroke="rgb(255,255,255)" stroke-width="2" paint-order="stroke"`. Re-initializing the same chart with `backgroundColor` set to `--dev3-surface-raised` flipped them to `fill="#ccc" stroke="rgb(14,18,30)"`. ECharts resolves its automatic label fill and outside stroke against `option.backgroundColor` and assumes white paper when that is transparent; the stroke is not configurable per label position without hand-coloring every series.

## Decision

`chartShellOption` in `src/assets/artifact-template/app.js` now declares `backgroundColor: tokenColor("--dev3-surface-raised")` as a default that report options can still override. The painted rectangle is the exact color of the `.card` the chart already sits in, so nothing changes visually, while every ECharts auto-contrast heuristic gets a truthful background in both themes. `AUTHORING.md` tells report authors not to touch it unless a chart sits on another surface.

## Risks

A chart hosted on a surface other than `--dev3-surface-raised` (`surface-base`, `surface-elevated`, a gradient) now paints a mismatched rectangle behind itself. Every `.chart-host` in the starter lives inside a `.card`, and the override is one option key away.

## Alternatives considered

Injecting per-series label defaults (`color` plus `textBorderWidth: 0`) instead: it fixes outside labels but throws away ECharts' inside-label contrast logic, and has to be re-applied for `emphasis`, per-datum labels, and every series type. Leaving the halo and asking report authors to color labels by hand: the same bug returns in every artifact nobody remembered to patch.
