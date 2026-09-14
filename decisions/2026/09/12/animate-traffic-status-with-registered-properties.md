# Animate traffic card status with registered custom properties

## Context

Task status is the one thing on an Agent traffic card that changes while the user
is watching it — in Live when the board moves, and continuously while scrubbing
Replay. Both the colour and the status word changed instantly, which reads as a
glitch on a stage the user is watching rather than as an event.

## Investigation

Every status-derived surface on the card (the 6% wash, the 2px top rule, the rail,
the dot, the verdict stamp, the cell-tier fill) is a `color-mix` or `var()` on two
inline custom properties, `--node-status` and `--node-ink`. Transitioning each
derived property separately would have meant six rules kept in sync by hand.

## Decision

`src/mainview/components/agent-traffic/traffic-nodes.css` registers both properties
with `@property { syntax: "<color>" }` — an unregistered custom property cannot
interpolate at all — and transitions them for 350ms. Every derived surface follows
for free.

Two traps worth knowing:

- The transition **must** be declared in the `.traffic-node-card:not(.is-unborn)`
  rule that already owns the card's appear transition. A second `transition` on the
  base `.traffic-node-card` selector is silently overridden by it, and the card then
  reports `transition-property: opacity, transform` with no status fade at all.
- Every reduced-motion override has to sit *after* the rule it turns off, in source
  order: same specificity, and a media query adds none. The card's own switch already
  exists further down the file and covers both card selectors, so nothing new is
  needed for it — but the cell-tier `color` transition needed its own block right
  after its declaration. Written beside the status-line switch, ~70 lines earlier, it
  measured `transition: color 0.35s` under `prefers-reduced-motion: reduce`.

The status word is its own component, `TrafficStatusLine.tsx`: the outgoing word is
kept for 220ms in one ghost slot — never a queue — absolutely positioned over the
line so a swap costs no layout movement, and a second change mid-fade drops the
stale word rather than stacking another animation. The plain word and the verdict
stamp share that one line box, so a status becoming `Completed` cross-fades the same
way one word becoming another does.

The first pass ran the colour at 350ms and the word at 220ms, and the user could not
see either one on a live board. Both were slowed — 700ms and 420ms — and the card now
also **travels** to its new slot: the slot comes from `kanbanOrder`, so a status change
is a board move, and the move is a far stronger cue than any fade of a 6% wash. The
slide is gated by `scene-shift.ts`: only when the same cards fill the same box does
`.traffic-nodes-cards` carry `data-shift="on"`. A filter toggle or an arrival re-lays
the scene out, and eighty cards gliding at once reads as a glitch.

The trip itself is a curve, and it runs entirely on the compositor. The layout still drops
the card straight into its new `left`/`top`; `card-travel.ts` measures where it came from and
hands the card four custom properties, and one shared three-keyframe animation moves only
`transform` — start offset, a mid-point bowed out perpendicular to the trip, then none (FLIP).
Direction picks the side: left goes over the top, right under the bottom, up round the left,
down round the right, so two cards trading places pass on opposite sides instead of through
each other. The bow is half the distance, capped at 260px.

Two traps behind the shape of that hook. The stage re-renders on every animation frame, so a
trip derived per render is dropped one frame in and the animation dies with it — it is held in
state for its full 560ms instead. And the offset must be applied before paint (`useLayoutEffect`),
or the card is seen in its new slot and then jumps back to start its trip. The two alternating
animation names exist because a second trip while the first is still running only restarts when
the name changes. Measured on the running app: 28 trips over 18 status steps, frame delta median
8ms, p95 9ms, max 48ms, and a sampled trip traced the arc exactly (1056px across, 260px up).

## Risks

`@property` needs Safari 16.4+ / Chromium 85+; older WebKit falls back to an instant
colour change, which is exactly today's behaviour. A card that is genuinely re-mounted
(entering the scene) shows its status without a fade — correct, and the reason nothing
animates when a filter re-flows the graph.

## Alternatives considered

Transitioning each derived property (`background`, `::before` background, rail,
dot, stamp background and shadow, cell ink) separately: six rules to keep in step,
and gradient interpolation where a single colour would do. Re-keying the card on
status to drive a CSS animation: a remount loses selection and restarts the card's
own appear transition.
