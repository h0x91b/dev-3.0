# Icon act loops only under a hovering pointer; focus and touch play it once

## Context
The four hand-drawn icon families (`tmx-`/`gtx-`/`hdr-`/`th-` in `src/mainview/index.css`) were gated on `.<family>-anim:hover` alone. Keyboard users never saw an icon act out its operation. Separately, a tap on a touch screen leaves `:hover` stuck until the next tap elsewhere, so a tapped icon looped indefinitely on a phone.

## Decision
Every family trigger is `.<family>-anim:is(:hover, :focus-visible)`. A single "Icon act" block, authored after the last family, sets `animation-iteration-count: 1` for `:focus-visible:not(:hover)` and for `:hover` under `@media (hover: none)`. State loops — `.remote-access-active`, `.hdr-rescan-busy` — are excluded on the host. `src/mainview/__tests__/icon-animation-hooks.test.ts` pins the trigger shape, the hook-to-rule mapping both ways, unplayed keyframes, the reduced-motion guards and the block's source position.

## Risks
The touch override ties the per-icon rules on specificity (0,3,0), so it only wins by source order. Moving a family block below it silently restores the infinite loop on touch. The test asserts the order. `:focus-visible` on a non-focusable wrapper host never matches, so a host must be the focusable control itself.

## Alternatives considered
- `:focus-within` — matches after a mouse click in Chromium, so it would start loops nobody asked for.
- `:has(:focus-visible)` — costly style invalidation on WebKitGTK, the engine behind the Linux freeze investigation.
- Looping on focus like hover — focus can rest on a control indefinitely (after Escape closes a menu), which is perpetual motion and CPU.
- Disabling the act on touch altogether — loses the tap feedback the tmux mobile rows were built to give.
