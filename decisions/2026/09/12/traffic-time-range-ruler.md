# The traffic time-range ruler draws context, not the selection

## Context

The Agent traffic replay transport could only name a window through presets —
`Last hour`, `Last 24 hours`, `Loaded history`, a calendar day. The two clock
labels under the replay track looked like a time axis and were not one: the
track itself is indexed by EVENT, not by time, so its middle is the middle of
the event list and never the middle of the hour. Asking for "the twenty minutes
around 14:30" meant picking a whole day and scrubbing.

## Investigation

Two things decided the shape, and both were found by building the obvious
version first.

**A selector cannot be its own domain.** The first ruler drew the loaded span —
everything paging had pulled. Paging keeps going until the oldest row is a day
old, and a quiet project's 500 newest messages reach back three weeks, so the
trailing hour the screen opens on came out **0.21% wide**: two pixels, nothing a
pointer can catch. Drawing the *selection* instead is the opposite failure — the
axis would collapse onto the band on every release, and only a preset could ever
widen it again.

**An effect is one render too late to hear the end of a gesture.** Registering
`pointermove`/`pointerup` from a `useEffect` keyed on the drag state left a gap
between the press and the listeners: a pointerup inside that gap was heard by
nobody, and the band then followed the cursor with no button held.

## Decision

`rulerDomain` (`src/mainview/components/agent-traffic/traffic-range.ts`) draws a
round span — the smallest of 1h/3h/6h/…/90d that is at least three times the
window — around the window rather than either extreme. It never draws earlier
than the oldest loaded instant, so a band cannot be dragged into history nobody
has read, and never later than now; when the window already covers everything
loaded, both clamps bite and the band simply fills the ruler.

`domainHolds` keeps that scale while the reader works: a fixed window (a dragged
range, a calendar day) reuses whatever scale is on screen as long as it still
contains the band and still draws it at 8% or more. Only a rolling preset is
recomputed every render, and its band is flush right either way.

A dragged interval is encoded into the SAME state the presets write —
`windowSize` gains a `range:<start>-<end>` form parsed by `trafficPeriodBounds`
(`traffic-period.ts`) — so there is one window, and a preset replaces a drag by
overwriting a string. `TrafficRangeRuler` registers its gesture listeners inside
the pointerdown handler, not from an effect.

## Risks

The ruler rescales when a drag takes the window past three times the drawn span;
that is visible, and is the price of never trapping the reader inside their own
selection. A range can only be drawn inside loaded history; older intervals come from the calendar or `Load older
messages`, deliberately, so dragging never triggers a page load.

## Alternatives considered

A second piece of state beside `windowSize` for the custom range: rejected —
every consumer would then have to know which of the two wins. Converting the
replay track itself from an event index to a time axis: rejected as a much
larger change to playback for no gain, since the cursor's instant is drawn on
the ruler as a hairline anyway. Giving the band a minimum pixel width so a
sliver stays grabbable: rejected — it draws an interval wider than it is.

## Hit targets

The handles are `min(24px, 50%)` of the band wide on a 24px track, 32px where the
primary pointer is coarse. The percentage is the point: each handle reaches half
its width into the band, so the two targets plus the move grip TILE the band and
can never overlap, however short an interval is drawn. A flat 24px would have the
two boxes crossing the moment a band drew narrower than 24 pixels, which is
exactly when a reliable grab matters most. The row pays for it in its own layout
— the track grew 20 → 24px — rather than by hanging over the playback slider
above it or the readout below.
