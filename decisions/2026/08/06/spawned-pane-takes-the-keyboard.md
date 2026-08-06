# 212 — A spawned agent pane takes the keyboard, and the viewer follows it

## Context

"+ Agent" opened a pane and left the user with nothing focused: the dialog's focus
trap restores focus to its trigger button on unmount, so the next keystroke went to
the "+ Agent" button instead of the agent. `TerminalView`'s type-to-focus fallback
did not help — it only fires when `document.activeElement` is `<body>`.

On a native task there was a second half to it: pane focus is client-local
(decision 179), and the viewer keeps its current pane across pane-state frames, so
even after the split the keyboard belonged to the *old* agent.

## Investigation

The tmux path was already correct server-side (`split-window` makes the new pane
active); only DOM focus was missing. The native path deliberately makes the new pane
the coordinator's active pane on split, and `openAuxPane` passes `restoreFocus: true`
precisely because an auxiliary pane (dev server, viewer) must NOT steal the agent's
keyboard — `spawnAgentInTask` does not, so its pane stays active.

## Decision

Three pieces, all in the renderer:

1. `useFocusTrap({ shouldRestoreFocus })` — a callback, not a flag, because the
   dialog decides in its click handler and unmounts in that same commit, so it never
   re-renders to publish a new value. `SpawnAgentModal` returns `false` after a
   successful spawn.
2. `src/mainview/terminal-focus-request.ts` — a request is a wish: the surface that
   started the agent asks, and `TaskTerminal` (the only component that knows which
   pane is focused and whether its canvas attached) answers when it can, or lets the
   wish expire after 15 s.
3. `TaskTerminal` adopts a pane that is BOTH brand new and the server's active one,
   and on native holds the pending wish until such a pane arrives. Serving it with
   the pane already on screen would type the new agent's prompt into the old agent,
   so a spawn that produces no pane focuses nothing at all.

## Risks

A viewer that polls between the native split and `openAuxPane`'s focus restore could
briefly see the aux pane as active and adopt it. The window is one RPC round trip
against a 2.5 s poll, and the consequence is a moved highlight, not lost input.

A second window spawning an agent moves this window's pane focus too — both viewers
see the same fresh active pane. Treated as correct: the pane was opened for the user,
not for one window.

## Alternatives considered

- Widen `TerminalView`'s type-to-focus fallback to fire while a button has focus —
  space and Enter would then activate the button and type at the same time.
- Drop the focus restore from `useFocusTrap` entirely — every other dialog needs it,
  and cancelling "+ Agent" must still return to the button.
- Have the server tell the client which pane to focus — contradicts decision 179;
  the pane set plus `activePaneId` already carries everything needed.
