# Agent-to-agent message toast carries two identities and its own hue

## Context

`dev3 message --task seq:N` types straight into another task's agent. Until now the
only trace was inside the receiving terminal: nothing on the board or in the
notification stack said that two agents were talking, so cross-task coordination
was invisible unless the user happened to be watching that pane.

## Decision

A dedicated push channel `agentMessage` (`src/shared/types.ts`) plus
`pushAgentMessage` (`src/bun/rpc-handlers/shared.ts`), raised from the single
delivery seam `deliverToTarget` in `src/bun/scheduled-message-scheduler.ts`, so an
immediate send and a queued "Send later" fire announce identically. The renderer
listener in `App.tsx` raises a toast with the new `agent` variant
(`src/mainview/toast.tsx`, token `--agent`, violet).

Two deliberate departures from the toast doctrine (`PRODUCT_UX_BIBLE` §5.7):

1. **The source line names two tasks** — `#7 Coordinator → #42 Receiver`. Every other
   toast has one origin; this event has a sender and a receiver, and "who wrote to
   whom" is the whole content.
2. **`agent` is an identity, not a severity.** Violet is the only hue no state token
   owns, so the toast cannot be misread as a status change, a warning, or a failure.

The click goes to the **receiver**: that is where the text landed and where the reply
gets typed. `unconfirmed` deliveries still announce (the text left the queue, and the
terminal is the only place to verify it); `not-delivered` and human-sent messages stay
silent.

## Risks

- Chatty coordinator fleets can raise many toasts. The existing five-visible cap,
  overflow-to-attention routing, focus mode and immersive-fullscreen queueing all
  apply unchanged, so the ceiling is the same as for any other push.
- The preview is clamped to 60 chars by `messagePreview`; a spilled oversized message
  previews as the pointer text, not the body. That is the honest thing to show.

## Alternatives considered

- **Reuse `cliToast` with `level: "info"`** — rejected: blue already means `dev3 notify`
  and watched-status banners, and the payload has no room for a second identity.
- **Source line = sender only, per the one-origin rule** — rejected: the click target
  is the receiver, so a screen reader would announce the wrong task as the destination.
- **Gate on `Task.watched`, like status banners** — rejected with the user: agent
  traffic is rare and is exactly what they asked to see by default.
