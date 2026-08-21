# The spaces rail is gated on its container's width, not the viewport

## Context

The rail hid itself twice: `hidden lg:flex` in CSS, and `useNarrowViewport(1024)`
in `Dashboard.tsx` to clear a space filter whose control had disappeared. Two
mechanisms for one decision, both reading the window.

## Investigation

The window is not the box the rail has to fit into. In the desktop shell the
dashboard sits inside app chrome; in remote mode it is a browser tab that may be
any width; a future split view changes it again. The two gates could also
disagree — the CSS query and the JS hook were only equal by coincidence of both
being written against 1024.

The trap in measuring is which box: measuring the rail's own sibling means showing
the rail shrinks the sibling, which hides the rail, which grows it again. The
flex row that holds *both* panels has a width that does not depend on the answer.

## Decision

`Dashboard.tsx` measures that row with the existing `useContainerWidth`
(ResizeObserver) and renders the rail only when the measurement is at least
`SPACES_RAIL_MIN_WIDTH` (1024, still exported from `SpacesRail.tsx`). The rail's
own `hidden lg:flex` is gone — one gate, in one place. A width of 0 means "not
laid out yet", never "narrow": `containerWidth || window.innerWidth` lets the
window stand in for the single frame before the observer reports, which also keeps
every existing test honest under happy-dom, where there is no layout at all.

## Risks

- No `ResizeObserver` means the width stays 0 and the window decides, without
  reacting to resize. Every target engine (Chromium, WKWebView) has it; the
  fallback is a static gate, not a broken one.
- One frame at mount may use the window's width. Visible only if the container
  and the window straddle 1024 in opposite directions.

## Alternatives considered

- **Keep the CSS query and drop the hook.** The filter-clearing effect needs the
  answer in JS, so the hook cannot go.
- **A new `useContainerNarrower` hook.** Written, then deleted: `useContainerWidth`
  already existed and one boolean of arithmetic does not justify a second hook.
- **Container queries in CSS.** Would still leave JS reading a different source
  for the same decision.
