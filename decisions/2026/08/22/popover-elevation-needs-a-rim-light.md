# Popover elevation on dark needs a rim light, not a bigger shadow

## Context

Tooltips read as glued to the surface under them — no sense of a floating layer. Every popover
in the app carried the same recipe: `bg-overlay border border-edge-active ring-1 ring-black/30
shadow-2xl shadow-black/60` (`src/mainview/components/Tooltip.tsx`, `HelpCard.tsx`,
`TaskTitleHoverCard.tsx`, and ~78 other call sites).

## Investigation

Observed in the browser (dark theme, QA instance): a tooltip over the dashboard's stats card
shows no cast shadow at all, only its 1px border. The arithmetic says why. `--surface-base` is
`rgb(6 9 22)`; black at 60% over it lands on `rgb(2 4 9)`, and after a 50px blur with -12px
spread the peak darkening is a couple of steps out of 255. A black shadow has nowhere to go on a
near-black page. The `ring-1 ring-black/30` had the same problem — a shadow in disguise, sitting
*inside* the border where it can only muddy the edge.

Two surfaces made it worse: `--surface-overlay` (27 33 48) and `--surface-elevated` (21 27 43)
are 6/255 apart, so a tooltip over a card had neither shadow nor tonal separation.

## Decision

A `--shadow-popover` token per theme (`src/mainview/index.css`), mapped to `shadow-popover` in
`tailwind.config.js` and applied to the tooltip family (`Tooltip`, `HelpCard`,
`TaskTitleHoverCard`, the first-run help callout in `GlobalHeader`). Dark stacks an outer dark
hairline (bites when the layer below is lighter), three black falloff steps, and
`inset 0 1px 0 rgb(255 255 255 / 0.07)` — the rim light is the part that actually reads as
"lifted", and unlike a cast shadow it works over any background. Light drops the rim (it washes
out on paper) and carries the separation in a heavier blue-grey shadow, matching
`--shadow-card-hover`'s hue. The `ring-1 ring-black/30` is gone.

## Risks

The token is applied to four surfaces, not all ~80. Menus, portals and modals still use the old
`shadow-2xl shadow-black/NN` recipe, so the app is briefly inconsistent — a deliberate scope
call, not an oversight. Sweeping them is a separate change.

The rim light assumes light comes from above. Any popover that is anchored *above* its trigger
still gets a top rim; at 7% white this reads as material, not as a wrong light source.

## Alternatives considered

- **Just enlarge the shadow.** Fails for the reason above: the page is already almost black.
- **Backdrop blur on popovers.** Strong separation cue, but it needs a translucent surface, and
  making tooltip text sit on live content underneath is a legibility trade for a cosmetic gain.
- **Lighten `--surface-overlay`.** The most effective single lever, and the widest blast radius:
  it repaints every modal and menu in the app. Left on the table as the next dial if the current
  amount of lift still reads flat.
