# Arm the usage panel's rows on dwell, not on a pin

Supersedes the pin-as-guard half of
`decisions/2026/08/29/default-account-switch-lives-in-the-usage-flyout.md`.

## Context

That record made a pinned panel the guard on the one mutation the header rate-limit readout
carries: picking the default agent account. Hover opened the flyout read-only; clicking the pill
pinned it, and only then were the rows choosable. The reasoning was right — a durable setting must
not be one stray click away from a panel a pointer merely crossed — but the first user to try it
reported the rows as simply broken: "радиобаттоны неактивные, я не могу переключить".

## Investigation

Driven in a browser, both states behave exactly as designed: on hover every row reports
`aria-disabled="true"` and `cursor: default`; after a click on the pill, six of eight report no
`aria-disabled` and `cursor: pointer`. So nothing was broken — the gate was unfindable.

Two reasons it is unfindable. The affordance for using the panel is the pill **above** the panel,
so the user must travel back out of the thing they are trying to use. And the only explanation is
one line of small muted text at the top, which is exactly the text nobody reads on a hover panel.

## Decision

Keep the guard, change the gesture: the rows arm after the pointer has rested inside the panel for
`ARM_DELAY_MS` (300 ms) — `AgentUsagePanel`'s own `dwelled` state, set by `onMouseEnter` and reset
by `onMouseLeave` on its container. `armed = interactive || dwelled`, where `interactive` is still
the no-dwell-needed arming: a pinned flyout, or the narrow BottomSheet.

A pointer crossing the header toward another icon does not linger inside the panel below it, so the
stray-click protection survives. A user who came to switch accounts has already spent far longer
than 300 ms reading the rows, so it costs them nothing and no click at all.

Two consequences: `rateLimits.pinToSwitch` is deleted in all three locales (the header now always
shows `panelSubtitle` — a two-state hint whose window is shorter than reading time would only
flicker), and the focus-enters-the-panel effect stays keyed to `interactive`, never to `armed`,
because moving focus under a mouse pointer steals it from wherever the user was typing.

## Risks

A deliberate click landing inside 300 ms of entering the panel is swallowed with no feedback. It
needs the user to click a row they have not read yet, so it is a theoretical path rather than a
real one; if it ever shows up, the fix is to arm on the first click and let the second one switch,
not to shorten the window.

## Alternatives considered

- **Drop the guard entirely** — simplest, and the mutation is only a preselect with a toast
  receipt, but it puts a real setting one accidental click away from a panel that opens on hover.
- **A "Pin to switch" button inside the panel** — keeps the guard fully and fixes findability, but
  switching still costs two clicks, which is the complaint.
