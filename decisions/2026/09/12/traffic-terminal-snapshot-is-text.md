# Agent traffic previews a terminal as text, because no pixel-capture primitive exists here

## Context

The Agent traffic inspector shows who a task is and what it said, but not what it is
doing. The ask was a screenshot of the selected task's current terminal, so the user can
judge an agent without opening the task.

## Investigation

No reusable pixel-capture primitive exists in this app today — which is a statement about
what is available to build on, not a claim that pixel capture is impossible. Every terminal
is painted by the renderer from a PTY stream; nothing snapshots a window, and there is no
per-task surface to snapshot. Building such a subsystem was out of scope and unauthorized.
The only screen reads that exist today are text: `tmux capture-pane` and the native backend's
`captureView`. Both already sit behind one contract, `src/shared/task-peek.ts` +
`src/bun/task-peek.ts` (`dev3 peek`), which strips escapes, names its three miss kinds
apart, and reports freshness per backend. On the native backend `captureView` returns
`not-enabled` in production (`decisions/2026/08/04/read-only-pane-capture-seam.md`), so a
native task has no screen to show at all — that is an answer, not a bug to paper over.

## Decision

Reuse the peek contract rather than build a second capture path. A new RPC,
`peekTaskTerminal` (`src/bun/rpc-handlers/task-panes.ts`), resolves the task **inside the
named project** and returns the same `TaskPeekSnapshot` the CLI renders;
`TrafficTerminalPeek.tsx` renders it as monospace text, labelled "text read off the
terminal, not a picture of it". Delivered scope is therefore a readable snapshot on tmux
only: a native-backend task, and so every task on Windows, gets no readable snapshot today
and is told so in plain words. No colours (the contract strips them), no input, no
polling, no prefetch: one node, one explicit Show, one Refresh. A new selection remounts
the component, and an answer whose `taskId` does not match the request is dropped, so a
late response can never paint another task's terminal.

## Risks

The tail is plain text, so a full-screen TUI (an agent's own status box) reads as broken
columns. It is also blurred under streamer mode, because terminal output carries paths and
names. A native-backend task — every task on Windows — has nothing to show, and says so
in one plain sentence with the backend's own token underneath as diagnostic text.

## Alternatives considered

An embedded live terminal (attaches, costs a PTY per glance, and turns the inspector into
a task workspace — forbidden by bible 5.9). `capture-pane -e` to keep ANSI colours: it
would need an ANSI renderer in the panel and still would not be a screenshot, so it buys
fidelity the surface does not need. A fourth `PeekUnavailableKind` for `not-enabled`:
it changes the agent-facing CLI contract for what is only a wording problem, so the UI
instead keys off a shared predicate over the detail the same module already writes
(`isCaptureUnsupported`), covered end to end in `task-peek.test.ts`.
