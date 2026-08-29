# The pane set decides when a native task's terminal is over, not the pane's key

## Context

Arseny reported on Windows (29 Aug 2026) that closing one auxiliary pane of a task
shut the whole task down while a second auxiliary pane was still in use. The brief
treated it as a Windows bug on the native backend.

It is not a Windows bug. `ptyDied` is the only signal that ends a task's terminal in
the UI: `TaskTerminal.tsx` returns early on it and replaces the entire terminal —
every pane, alive or not — with the "session ended" screen. Pane 1 of a native task
is bound under the bare `taskId` in `pty-server.ts`, and both `createNativeTaskSession`
and `reattachNativeTaskSession` passed `onClosed: () => markNativeClosed(session)`,
which published that death unconditionally. Panes 2..N live under a composite
`taskId~paneId` key and published nothing, by an explicit comment.

So the outcome depended on which KEY the closing pane held rather than on whether
anything survived it.

## Investigation

`src/bun/__tests__/aux-pane-close-keeps-task.bun-e2e.ts` drives the real close RPC
(`taskPaneAction`, what the renderer's `runPaneAction` calls) against real hosts and
shells. On macOS, before the fix: closing any pane 2..N of three or four published
nothing, while closing pane 1 left both siblings in the pane set with live host and
shell pids and published one `ptyDied`. Observed, on this platform, not inferred —
and not a reproduction of Arseny's gesture, which nobody has been able to run.

## Decision

`markNativeClosed` (`src/bun/pty-server.ts`) now reads the task's pane set and
publishes `ptyDied` only when no pane survives the one that closed; the closed pane
is discounted by id, because the read races the close it reacts to. A surviving pane
set instead drops the stale bare-key session (`dropStaleNativeBinding`), so the
survivor that slides into index 0 rebinds on the next viewer attach — `getPanePtyUrl`
picks the bare-key pane by POSITION, so leaving the dead entry would render a live
pane as a dead one. Panes 2..N now route through the same function, so the rule is
one rule.

**The last pane.** What the code did before: pane 1 closing ended the terminal
whatever else was alive, and an aux pane closing never did — so a task whose pane 1
had already gone could lose its final pane and still show a terminal. What we chose:
the pane set running out IS the terminal ending, so the last close publishes the
death whichever pane it happens to be, and the user gets the "session ended" screen
with its Restart button. The alternative — never publishing, and letting the pane
poll's `sessionAbsent` path draw the empty state — was rejected: it needs two
consecutive absent reads, so it is strictly slower at saying the same thing.

## Risks

A pane host that dies while siblings live now leaves the task's terminal up with a
dead pane box in it, which is the intended reading but a visible change. The pane-set
read is asynchronous, so the death arrives a few milliseconds later than it used to;
an unreadable pane set is deliberately treated as "no panes survive", keeping the
old behaviour as the failure mode. The e2e's negative assertions therefore need a
settle window — asserting the instant the RPC resolves passed against a
deliberately broken build during this task's own mutation check.

## Alternatives considered

Suppressing the death at the close call site (`nativePaneAction`) instead: rejected,
because a pane also dies when its shell exits, and that path would have kept the bug.
Rebinding the bare key to a survivor inside `markNativeClosed` rather than dropping
it: rejected as a second implementation of what `reattachNativeTaskSession` already
does on the next attach.
