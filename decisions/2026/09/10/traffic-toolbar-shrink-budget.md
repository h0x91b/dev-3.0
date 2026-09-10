# Agent traffic toolbar: the shrink budget belongs to the selects

## Context

`.traffic-toolbar` is one nowrap flex row above 700px. Between roughly 700px and
1500px its natural content is wider than the window, so flexbox has to take the
difference out of some child.

## Investigation

Measured in the running app on `ce06a49ac` (Experiment 2, two kinds present),
and re-measured on `caf01b17c` once the notification kind made the group a third
button wider:
at 1440px the `Live` readout was already ellipsised to 24px of its natural 36px,
at 1360px it was 0px wide, and from 1330px down the `Replay` button was cut by
the toolbar's right edge (30px at 1280, 160px at 901). The cause is
`.traffic-toolbar > .traffic-toolbar-tail { min-width: 0 }`: the tail is the only
child that can shrink to nothing, so it absorbed the whole deficit while the two
selects sat at their full 240px. At 390px the same generic `> div { max-width:
150px }` cap squeezed the Experiment picker below its two buttons' width and it
painted them over the `Filters` and `Messages` controls.

## Decision

In `traffic-orbit.css`: `.traffic-toggles` and `.traffic-experiment` take their
natural width at every width (`flex: 0 0 auto`) — a group of labelled buttons
cannot shrink, only spill — and above 700px the tail does the same, which moves
the shrink budget onto the selects and the search field. A 701–1200px band drops
the selects to a 96px floor and compacts the tail the way the sub-900 rules
already do. In `traffic-nodes.css` the Experiment 2 picker stops growing
(`flex: 1` → `flex: 0 0 auto`) so the collapsed filter row keeps its room.

With three kinds the inline row is still 54px too wide at 901px after all of
that, so Experiment 2's filter collapse moves from 900px to **1200px**
(`useNarrowViewport` in `AgentTrafficScreen.tsx`): below it the filters live in
the sheet the screen already has, and the row that remains fits with room to
spare. A 701–1050px band compacts the button groups' padding, reaching past the
collapse point because the first pixels above it are the widest the inline row
ever has to be.

**The numbers come from the longest translation, not from English.** Re-measured
in `ru` and `es`: the live readout is `Live` at 36px, `En directo` at 70px and
`В реальном времени` at 137px, and the two button groups run 74px wider in
Russian. Full size therefore fits from ~1310px in English but only from ~1790px
in Russian. Hence the 1200px collapse point (Russian still overflowed at 1150px,
Spanish at 1100px), the compaction band reaching to 1500px, and the readout caps
of 92px / 64px in the two bands — the readout keeps its `title`, exactly as it
already did below 900px. Experiment 1 has no sheet at all and its own stage
action is `Приостановить анимацию`, so below 900px its toolbar wraps; Experiment
2's more specific nowrap rule is untouched there.

Toolbar height above 900px is unchanged at 57px, which the absolutely positioned
`.traffic-summary` (`top: 108px`) and `.traffic-nodes-bands` (`top: 65px`) depend
on. At 390px the toolbar gains one wrapped row (107px → 143px) — the price of
the controls not overlapping.

## Risks

The band boundaries are arithmetic on the current control set and on the three
shipped locales. Another control in the toolbar, a fourth kind, or a fourth
locale with longer labels re-opens the range; the guard is a measured width sweep, not a test,
because layout needs a real engine. Between 900px and 1200px a desktop user now
reaches the filters through the sheet rather than inline, and between 1200px and
1500px the stage action shows its icon without its label — both deliberate costs
of keeping every control on screen in every language.

## Alternatives considered

Wrapping the toolbar above 900px was rejected: the Experiment 2 summary and
node bands are positioned against a fixed toolbar height and would misalign.
Lowering the filter-collapse breakpoint was rejected as a behaviour change —
it hides working controls behind a sheet on an ordinary desktop.
