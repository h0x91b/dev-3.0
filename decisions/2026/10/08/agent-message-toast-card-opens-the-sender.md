# The agent-message toast card opens the sender, and toasts ignore stray clicks

## Context

A user reported that clicking the violet `dev3 message` toast "opens the experiment" (agent traffic, an experimental setting) and "sometimes an artifact". These toasts appear over the docked artifact panel, so a click meant for the artifact took them somewhere else, and it took several actions to get back. They asked for buttons-only navigation, or at least the sender as the default.

## Investigation

Two causes, reproduced in an isolated harness with the real `ToastHost`. Traffic was the intended card destination (`decisions/2026/10/02/agent-message-toast-names-every-destination.md`), so that was a default to change, not a routing bug. The artifact jump was a stack bug. An agent toast is capped at one copy, and a newer one removed its predecessor and was appended at the bottom, so the toast below (`cliShowArtifact`, "Agent shared an artifact") slid up into the slot the pointer was on (y 178→56 measured). Removing a toast for any other reason (dismiss, timeout) shifts the stack the same way.

## Decision

- `agentMessageToast` (`src/mainview/agent-message-toast.tsx`, extracted from `App.tsx`) gives the card `openEnd(sender)`. Agent traffic is reached only through its own action. With no `fromTaskId` the card is inert, and the toast passes no `taskId`, because the host's `resolveOrigin` would otherwise turn it into a click on the recipient.
- `ToastHost` puts a superseding agent toast in its predecessor's slot.
- `ToastCard` ignores pointer navigation (card, links, actions) pressed within `TOAST_ARM_MS` (600 ms) of the card appearing or its `top` changing. Keyboard activation (`detail === 0`) and Dismiss are never delayed. `test-setup.ts` sets the delay to 0, and `toast.test.tsx` covers the guard.

## Risks

A deliberate click within 600 ms of a toast arriving or moving does nothing. That is rare, and a second click works. A move that re-renders no card (the pinned update prompt appearing above the stack) does not re-arm.

## Alternatives considered

Buttons only (inert card): the user rejected this on 2026-10-02, and the sender default covers the request. Prepending new toasts: this moves every existing toast on each arrival, which is worse. Moving toasts off the artifact panel: a placement change for every toast, out of scope.
