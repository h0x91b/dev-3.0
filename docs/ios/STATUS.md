# Native iOS companion status

Last updated: 2026-07-16

This is the live execution status for [IMPLEMENTATION.md](IMPLEMENTATION.md). It tracks evidence and remaining gates; the implementation plan remains the scope and acceptance-criteria source of truth.

## Core flow

| Area | State | Evidence / next gate |
|---|---|---|
| Pair and reconnect | Live green | Fresh manual pairing, saved-session cold launch, one refresh/RPC connection/refetch, and no immediate reconnect churn. |
| Browse and create | Live green | Work/Projects navigation, one task creation, agent/config selection, preparation, and terminal handoff. Required Description affordance is implemented; final simulator visual check remains. |
| Running-task terminal | In progress | Composer input, exact agent response, away/back reattach, task metadata update, and cold PTY continuity passed. The apparent redraw defect was a Light-device/Dark-instance mismatch; the terminal canvas now follows the instance theme, with final zoom recording pending. |
| PTY recovery | In progress | Same-process cold reattach and scene/network kick implementation tests are green. Live background/foreground and interruption continuity QA remains. |
| Task Info | Live partial | Priority round-trip passed without changing the terminal session. Remaining destructive/completion path is held for the final end-to-end pass. |
| Completion cleanup | Pending | Complete the live task through the native approval flow, then verify route dismissal, tmux teardown, and worktree removal. |

## Core QA still required

- Pinch in/out and double-tap reset with Light device chrome and a uniform Dark-instance terminal background.
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

- `ios/qa-output/critical-running-task-e2e-part1.mp4`: creation, terminal input, metadata, navigation, zoom attempt, and cold continuity; it captures the device/instance theme mismatch found during QA.
- `ios/qa-output/critical-running-task-e2e-part2.mp4`: fixed cold bootstrap and exact same-PTY reattachment.
- `ios/qa-output/critical-running-task-e2e-part3.mp4`: diagnostic Light-device/Dark-instance comparison that rejected the false backing-raster workaround.
- A final recording will cover the corrected zoom, raw/pane/window controls, recovery, and completion cleanup.

## Verification baseline

- Dev3Kit: 94 tests passing.
- Dev3UI: 105 tests passing.
- Dev3TerminalKit: 31 tests passing.
- SwiftFormat and strict SwiftLint are clean for tracked iOS sources.
- Backend lint and all 5,783 fast mainview, Bun, and CLI tests pass at the current gate.
