# Hold the launch countdown the moment a user touches the dialog

## Context

The agent launch-approval dialog ("Agent wants to start this task") approves
itself after a delay so a blocked CLI is not stranded by an absent user. That
delay applied to a present user too: someone reading the dialog, picking a
harness or adding a variant could have the task launched mid-edit, with the
choice they had half-finished. The default delay was 5 minutes.

## Investigation

The countdown in `AgentLaunchRequestModal.tsx` is only a mirror — the timer that
actually approves lives in the bun process (`src/bun/agent-requests.ts`), and it
is re-armed once when a client reports the dialog on screen
(`markAgentRequestShown`). So hiding the countdown in the renderer would have
left the launch armed. The request is also broadcast to every window and remote
browser, and a retrying agent joins the same entry instead of creating a new one
— both are paths that could re-arm a cancelled timer.

## Decision

`holdAgentRequestAutoApprove(requestId)` (`src/bun/agent-requests.ts`) clears the
timer, nulls the deadline and sets a one-way `heldByUser` flag, so neither a
re-display (`markAgentRequestShown` returns early on it) nor a joining retry can
re-arm it. It pushes `agentLaunchAutoApproveHeld` so copies of the dialog on
other clients stop their countdown too. The renderer calls it through the
`holdAgentLaunchAutoApprove` RPC from `onPointerDownCapture` / `onKeyDownCapture`
on the dialog container — events only a human raises, so mount, autofocus and
programmatic updates do not trigger it, and a cursor passing over the dialog does
not either. The footer then says "Waiting for your answer" in the countdown's
slot. The unattended default dropped from 5 minutes to 1
(`DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES`); a configured value and the "Never"
option are untouched.

## Risks

A user who touches the dialog and walks away blocks the requesting agent until
the CLI's own socket timeout (10 minutes, `LAUNCH_APPROVAL_TIMEOUT_MS`) — that is
the intended trade: a launch nobody chose is worse than an agent that has to ask
again. Interaction is detected per client, so a hold on one window travels to the
others only through the push; a client that is offline keeps drawing a countdown
until it reconnects, but it cannot launch anything — the bun timer is the only
thing that can, and it is already cancelled.

## Alternatives considered

Pausing the countdown and resuming it after a spell of inactivity: rejected — the
launch would still fire behind a user who is thinking or reading the task's
overview. Cancelling only the displayed countdown and leaving the bun timer:
rejected, that is the bug, not the fix. Treating mouse movement as interaction:
rejected — a cursor crossing the dialog is not a decision to engage with it.
