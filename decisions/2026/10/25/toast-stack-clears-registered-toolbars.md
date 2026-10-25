# Toast stack clears registered toolbars

## Context

`ToastHost` sat at a fixed `top-14` (56px). That only cleared the app header on the desktop
board. In a task the toolbar rows and terminal tabs reach ~180px, so the stack covered
`+ Agent` and the task actions; in browser mode the in-page menu bar pushes even the header
below 56px.

## Decision

Chrome the stack must never cover registers itself with a stable callback ref,
`toastClearanceRef` (`src/mainview/toast-clearance.ts`): the app `<header>`, `TaskInfoPanel`,
the `ProjectTerminal` bar and `LabelFilterBar`. The terminal window strip (`TerminalWindowNav`)
deliberately does not register: it is mostly empty on the right, and clearing it cost a whole
row of terminal for nothing. Its tabs can sit under a toast when there are many windows. `ToastHost`
(`useToastStackTop` in `src/mainview/toast.tsx`) takes the lowest bottom edge of the registered
nodes that reach into its right-hand column, re-measuring on registration, `ResizeObserver`,
window resize and every stack change. The stack keeps 8rem for a card on short windows and its
height is capped to the viewport, so a tall pile scrolls instead of being clipped.

The registry is its own module so toolbars do not import `toast.tsx` — dozens of suites mock
that module partially. `ToastHost` remains the single owner of the corner
(`decisions/2026/08/26/one-owner-per-screen-corner.md`).

## Risks

A new top toolbar that does not register gets covered again; the toast suite scans the wiring
of the known surfaces. Chrome that moves without resizing while toasts are already showing is
only picked up at the next stack change or resize.

## Alternatives considered

- **A larger fixed offset.** Wrong on every screen but one, and wrong again at another UI scale
  or when a toolbar wraps.
- **Rendering the host inside each screen below its toolbar.** Splits the one-owner corner into
  several hosts and loses stacking across screens.
- **A MutationObserver scan for marked elements.** Works without call sites but watches the
  whole document, terminals included, for a few toolbar rows.
