# Agent approval dialogs ignore backdrop clicks

## Context

Every agent-initiated approval — a launch request (`AgentLaunchRequestModal`), a
completion request and a cancellation request (both `confirm({ agentInitiated: true })`)
— holds a blocked `dev3` CLI on the other end. The dialog appears unprompted,
often while the user is clicking somewhere else, and both surfaces dismissed on a
backdrop `mousedown` by answering `false`. The requesting agent then received
"user declined" (exit code 10) for a dialog nobody read. Reproduced repeatedly on
coordinator-created task starts (Seq1826, Seq1828).

## Decision

Backdrop dismissal is off for these dialogs.

- `src/mainview/components/AgentLaunchRequestModal.tsx` — the backdrop's
  `onMouseDown` no longer answers; it only calls `preventDefault()`.
- `src/mainview/confirm.tsx` — `dismissOnBackdrop` now defaults to
  `!agentInitiated` instead of `true`. An explicit `dismissOnBackdrop` still wins
  either way, and ordinary user-triggered confirms are unchanged.

Both surfaces `preventDefault()` the press they ignore. Without it the browser
moves focus to `body`, which costs a keyboard or screen-reader user their place
in the dialog until the next Tab pulls them back through the focus trap.

Escape still declines on both surfaces, and the Decline/Cancel button is still
autofocused: cancelling stays available, it just has to be deliberate. Nothing
about the queue, the auto-approval countdown, retry/dedupe or the timeout changes
— ignoring the backdrop is never read as approval, the request simply stays
pending.

## Risks

A user who learned to dismiss these dialogs by clicking away now has to press
Escape or Decline. That is the point, and both remain one action. A dialog that
somehow renders with no reachable buttons would be harder to escape — the focus
trap plus the Escape handler make that unlikely.

## Alternatives considered

- **Fix only the launch modal.** Rejected: completion and cancellation requests
  are the same blocked-CLI contract with the same misclick.
- **Require a full press-and-release on the backdrop** (`mousedown` and `mouseup`
  both outside). Still declines on a deliberate-looking stray click, which is
  exactly what happened.
- **Turn backdrop dismissal off app-wide.** Out of scope; ordinary menus and
  modals lose nothing by closing on an outside click.
