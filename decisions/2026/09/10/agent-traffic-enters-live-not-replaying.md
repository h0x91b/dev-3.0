# Agent traffic enters on Live with Follow, not on an automatic replay

## Context

`decisions/2026/09/08/agent-traffic-becomes-a-destination.md` ruled that entering the
Agent traffic route autoplays the trailing hour once. Living with it reversed the
ruling: the reader opens the screen to see what is happening *now*, and an automatic
replay takes the stage — the cursor sits in the past, cards are reconstructed from
recorded board moves, and the first interaction anyone has is stopping something they
never asked to start.

## Decision

Entry is Live. `AgentTrafficScreen.tsx` drops the one-shot autoplay effect, its
`autoplayed` ref, `startEntryReplay`, and the `useReducedMotion` read that only served
it. With no cursor placed, `useTrafficPlayback` stays at `index === -1`, which is Live,
and `TrafficNodes` keeps its `follow` default of `true` — so the camera follows live
traffic on arrival with no new state and no new control.

Replay is untouched and still explicit: the transport's Play, the toolbar's `Replay`,
and Space all call `playPause()`, which starts at the window's first event. The period
default (`ENTRY_WINDOW = "hour"`), the project/time filters, both experiments, manual
camera interaction and the notification/history data are unchanged.
`useTrafficPlayback.seekToTime` keeps its contract and its tests; it simply has no
caller on the entry path any more.

## Risks

- A reader who liked the automatic recap now has to press Play. That is the point of
  the reversal, and the control is the most prominent one in the transport.
- Seq 1833 is adding a notification arm to the same screen's readiness gating. The gate
  that arm was meant to feed (the autoplay latch) no longer exists, so nothing about
  entry depends on when notifications settle.

## Alternatives considered

- **A setting to choose entry mode.** Rejected: it is one small default, and a toggle
  for it is exactly the control creep the UX bible warns about.
- **Keep the autoplay under `prefers-reduced-motion` only.** Rejected: the objection is
  that the stage is hijacked, not that it moves.
