# Giving a plain mouse wheel a way into horizontal-only scroll containers

## Context

The UI had been driven almost exclusively from a Mac trackpad. A trackpad's
two-finger swipe arrives as a wheel event carrying `deltaX`; a plain mouse has
no horizontal axis and can only ever produce `deltaY`. Chromium does not
translate a vertical wheel onto a container that can only scroll sideways.

## Investigation

Driven in headless Chromium with `agent-browser mouse wheel`, which goes through
CDP `Input.dispatchMouseEvent type=mouseWheel` and yields a trusted event
`{deltaX: 0, deltaY: 120, deltaMode: 0, wheelDeltaY: -120}` — identical to a
Windows or Linux notch. On the real board, 12 notches left `scrollLeft` at 0
while 896px of columns sat off-screen; the same 12 events carrying a horizontal
delta drove it to the end. A bare `overflow-x:auto; overflow-y:hidden` probe with
no dev3 code behaved the same, confirming this is Chromium's own behaviour rather
than a regression. `Shift`+wheel could not be tested at all: Chromium performs
that mapping above `Input.dispatchMouseEvent`, proven with a two-axis control
probe that moved vertically under `Shift`+wheel.

## Decision

One document-level bridge, `src/mainview/utils/horizontal-wheel.ts`, installed
from `App.tsx`. `resolveHorizontalWheelTarget` walks from the event target to the
root; the first vertically-scrollable ancestor wins and the event is left alone,
otherwise the nearest horizontally-scrollable ancestor gets `scrollLeft += deltaY`
and the event is consumed. Containers listed in `WHEEL_X_SELECTOR` — short,
unmistakably sideways strips carrying `data-wheel-x`, plus markdown tables and
mermaid diagrams — win on sight even when the page behind them scrolls. Code
blocks in `.dev3-pr-md` wrap instead (`TaskDiffViewer.css`), matching the
`overflow-wrap: anywhere` the surrounding document already uses.

## Risks

The opt-in list pins the page whenever the cursor rests on one of those strips.
That is why prose containers are deliberately excluded: a code block inside a
7600px diff would otherwise freeze the page every time the pointer crossed it.
Wrapping code blocks is a visible rendering change to pull-request bodies and is
reversible in one CSS declaration.

## Alternatives considered

Per-container `onWheel` handlers: same behaviour, repeated in a dozen components,
and blind to markdown-generated DOM such as `<pre>` and `<table>`. An
always-visible horizontal scrollbar: measured as ineffective — even an explicitly
styled `::-webkit-scrollbar` reserved zero layout height in this Chromium, so the
bar stays an overlay. Documenting the arrow keys, which move 40px per press:
undiscoverable and 15 presses wide.
