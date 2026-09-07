# Two agent-traffic presentations, defaulting to the node graph

## Context

`decisions/2026/09/05/live-agent-traffic-orbit.md` replaced the traffic log with one 3D orbit and
labelled it "Experiment 1", implying a second experiment nobody had built. The user then asked for
that second presentation — a flat animated node graph — to exist beside the orbit and to be what the
surface opens with, while the Settings toggle keeps governing whether agent traffic exists at all.

## Investigation

Nothing node-graph-shaped had ever shipped. At the time of the ruling `main` contained exactly one
visualization (`TrafficOrbit`); the surface #1657 replaced was a plain row log (`TrafficRow`), and
every earlier graph attempt (`AgentTrafficConcepts.tsx`, the `AgentMessageToast` hub-and-legs
composition) lived only on unmerged branches. The user confirmed that Experiment 2 means a live
implementation of the concept file `~/Downloads/dev3-coordination-v3.html`, which is why the card,
wire and level-of-detail vocabulary here follows that file (it was authored against dev3's own
design tokens, so the port needed no new colours).

## Decision

`TrafficNodes.tsx` is a second **stage**, not a second feature: `AgentTrafficLog` already owned the
data, filters, timeline, selection and inspector and passed the orbit a narrow prop contract, so the
node graph implements the same contract and the parent renders one or the other. Only one is mounted,
which is what keeps a switch from leaving a second observer or animation loop behind. Layout and wire
geometry are pure functions in `nodes-layout.ts` so the scene is unit-testable and a message's
position along a wire comes from arithmetic rather than an SVG measurement.

The pick is `GlobalSettings.agentTrafficExperiment` (`"1" | "2"`), read and written by
`useTrafficExperiment` only while the overlay is open. **Absent means Experiment 2, for upgrades
too**: an install that turned `experimentalAgentTraffic` on before this existed was never offered a
presentation, so treating the old flag as a vote for the orbit would invent consent. The selector is
a radiogroup leading the overlay toolbar — the diff viewer's precedent for mutually exclusive view
modes — and it never writes the feature flag.

## Risks

The bible landed within a handful of bytes of its 128 KB budget, so §5.9 was compacted to pay for the
new rule; a parallel edit to `docs/ux` can push it over and will need another compaction pass rather
than a raised cap. `FIT_FLOOR` means auto-fit stops shrinking at 55% and a very large board opens
partly off-screen, panned to centre — deliberate, because cards below that scale cannot be read.

## Alternatives considered

Putting the selector in Settings: rejected, it is a view mode over one surface, and it would have
conflated "which presentation" with "is the feature on" in the same panel. Keeping the orbit as the
only view and restyling it: rejected, the user asked for both. Deleting the orbit: rejected by the
no-deprecation rule read in reverse — both presentations are intentionally supported.
