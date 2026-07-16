# Native iOS companion status

Last updated: 2026-07-16

This is the live execution status for [IMPLEMENTATION.md](IMPLEMENTATION.md). It tracks evidence and remaining gates; the implementation plan remains the scope and acceptance-criteria source of truth.

## Core flow

| Area | State | Evidence / next gate |
|---|---|---|
| Pair and reconnect | Live green | Fresh manual pairing, saved-session cold launch, one refresh/RPC connection/refetch, and no immediate reconnect churn. |
| Browse and create | Live green | Work/Projects navigation, one task creation, agent/config selection, preparation, and terminal handoff. Required Description affordance is implemented; final simulator visual check remains. |
| Running-task terminal | In progress | Composer input and exact agent response, away/back reattach, task metadata update, and cold PTY continuity passed. Zoom preference values passed, but the recorded pass exposed redraw corruption; the backing-store fix is under test. |
| PTY recovery | In progress | Same-process cold reattach passed. Scene-foreground and network-path PTY kick wiring is being added before recovery QA. |
| Task Info | Live partial | Priority round-trip passed without changing the terminal session. Remaining destructive/completion path is held for the final end-to-end pass. |
| Completion cleanup | Pending | Complete the live task through the native approval flow, then verify route dismissal, tmux teardown, and worktree removal. |

## Core QA still required

- Pinch in/out and double-tap reset with a uniform themed terminal background.
- Raw-mode input plus hardware-key handling.
- Split, switch, and close panes; create and navigate a tmux window.
- Background/foreground and remote-server interruption recovery with PTY continuity.
- Final completion approval and cleanup.

## Later waves

- Make the existing native Diff and PR Status destinations reachable from Task Info.
- Finish Settings: appearance, terminal default, and About.
- Run and document the resilience matrix, accessibility/device pass, and performance measurements.
- Finish signing, export-compliance, and TestFlight workflow documentation.
- Keep Agent Cockpit and other non-v1 surfaces behind the core and release gates above.

## Recorded evidence

- `ios/qa-output/critical-running-task-e2e-part1.mp4`: creation, terminal input, metadata, navigation, zoom attempt, and cold continuity; it intentionally captures the zoom redraw defect found during QA.
- `ios/qa-output/critical-running-task-e2e-part2.mp4`: fixed cold bootstrap and exact same-PTY reattachment.
- A final recording will cover the corrected zoom, raw/pane/window controls, recovery, and completion cleanup.

## Verification baseline

- Dev3Kit: 93 tests passing.
- Dev3UI: 103 tests passing.
- Dev3TerminalKit: 29 tests passing before the active redraw regression is added.
- SwiftFormat and strict SwiftLint are clean for tracked iOS sources.
- Backend lint and fast test suites passed earlier in this implementation run and will be rerun at the final gate.
