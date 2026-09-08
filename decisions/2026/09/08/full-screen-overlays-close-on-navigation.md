# The traffic log closes on navigation, and Space drives its replay

## Context

Two keyboard complaints against the agent-traffic surface: ⌘1–9 "did not work" while the
traffic log was open, and Space did nothing on a stage whose whole point is a replay.

## Investigation

⌘1–9 was never swallowed. `App.tsx` handled it, `navigateToProject` ran, and the project
behind the overlay changed — verified live in the browser build via the remote alias
(`g` then a digit, the same navigation path): the heading behind the dialog went
`second-project` → `QA Fixture` while `[data-testid="agent-traffic-log-dialog"]` stayed
mounted. The traffic log covers the whole screen, so a navigation nobody can see is
indistinguishable from a dead key. Every other full-screen layer already had this rule —
the task-hint overlay closes on `state.route` two effects above.

Space had no handler at all. It cannot get one through `keymap.ts` either: `Space` is in
`RESERVED_CODES` (`keymap-bindings.ts`) because it activates whatever control holds focus,
so the registry refuses to dispatch it.

## Decision

1. `App.tsx` closes the traffic log in an effect on `state.route`, next to the identical
   hint-overlay effect. Navigation is what makes the destination visible.
2. `TrafficView` (`AgentTrafficLog.tsx`) hand-writes the Space handler, in the same
   non-remappable class as the `g` chord. It fires only in Experiment 2 with events to
   play, and stands down for: any modifier, `repeat`, `isComposing`, `isTypingContext()`,
   a focused `button`/`a[href]`/`role=button|radio|option`, and any open overlay layer
   (`getOverlayLayerElements()` — the Selects and the calendar). It calls the transport's
   own `playPause`, so restart-when-finished and live semantics are the button's, not a
   second implementation, and it `preventDefault`s so the page cannot scroll.
3. `keymap.ts` carries a display-only `traffic-replay-play-pause` entry
   (`primary: []`, `remappable: false`, gated on the traffic beta) so the shortcuts
   overlay and `docs/keyboard-shortcuts.md` print a key the registry cannot dispatch.

Reduced motion needs no branch here: Space is the Play button, and the stage already
suppresses flights and glides under `useReducedMotion`.

## Risks

- Closing on every route change also closes the log on a navigation the user did not
  initiate (a notification jump). That is the hint overlay's behaviour too, and an
  overlay outliving the screen it was opened over is the worse failure.
- A future focusable control with none of the listed roles would swallow Space twice.
  The negative guards in `agent-traffic-ui.test.tsx` cover the current set.

## Alternatives considered

- **Close the log from each navigation call site.** Five call sites and counting; the
  next one added would forget, which is exactly how this bug happened.
- **Leave the log open and re-scope it to the new project.** It would answer a navigation
  with a filter change, and ⌘1–9 means "show me that project", not "filter this overlay".
- **Register Space in `keymap.ts` as a real binding.** Refused by `RESERVED_CODES`, and
  rightly: a user who rebound it away would lose Enter/Space activation semantics.
