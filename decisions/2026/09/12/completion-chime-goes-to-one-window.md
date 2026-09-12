# Completion chime goes to one window, browsers keep the fan-out

## Context

Completions no renderer played locally (CLI `dev3 task move`, the approval
dialog, branch-merge auto-complete) are announced with the `taskSound` push.
That push went through `pushEverywhere`, which broadcasts to every Electrobun
window, so a user with two windows open heard one finished task chime twice.

## Investigation

The renderer cannot fix this: `src/mainview/task-sounds.ts` keeps its pending
queue and autoplay flag in module state, and each window runs its own copy, so a
local Set never sees another window's chime. The only choke point is delivery,
in `src/bun/push-targets.ts`.

## Decision

`pushEverywhere` keeps a small `SINGLE_WINDOW_PUSHES` set; `taskSound` is in it
and routes through `sendToFocusedWindow` instead of `broadcastToAllWindows`.
Windows share one pair of speakers, so a sound is not state. Browser clients keep
the full fan-out on purpose: a phone on the LAN is a different device in a
different room, and a remote-only setup has no window to chime at all.

## Risks

A desktop window and a remote browser on the same machine still chime twice —
unchanged from before, and not distinguishable from the legitimate second-device
case without an identity the push does not carry. If no window has ever been
focused, `getFocusedWindow` falls back to the first tracked window.

## Alternatives considered

Cross-window dedup in the renderer (BroadcastChannel or a shared store): needs a
leader election and a race window, and still cannot reach a remote browser.
Pushing to no window and letting the initiating surface own every sound: breaks
CLI and agent-approval completions, which have no initiating surface.
