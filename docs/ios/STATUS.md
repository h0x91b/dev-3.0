# Native iOS companion status

Last updated: 2026-07-16

This is the live execution status for [IMPLEMENTATION.md](IMPLEMENTATION.md). It tracks evidence and remaining gates; the implementation plan remains the scope and acceptance-criteria source of truth.

## Core flow

| Area | State | Evidence / next gate |
|---|---|---|
| Pair and reconnect | Live green | Fresh manual pairing, saved-session cold launch, one refresh/RPC connection/refetch, and no immediate reconnect churn. |
| Browse and create | Live green | Work/Projects navigation, one task creation, agent/config selection, preparation, and terminal handoff passed. Simulator accessibility and visual QA confirm the required Description affordance. |
| Running-task terminal | Live green | Composer and raw accessory input, exact agent responses, zoom, pane/window lifecycle, task metadata update, and cold PTY continuity passed. The terminal follows the instance theme, raw Enter clears UIKit input state, and hardware-key sequences are unit-covered. |
| PTY recovery | Live green | Cold reattach, true Home-to-foreground recovery with the same app PID, and remote-server interruption recovery all retained the same durable tmux session and worktree. |
| Task Info | Live green | Title save/reset, owner overview, built-in and custom status moves, watch, labels, notes, branch/PR refresh, priority, cancel cleanup, Todo deletion, and native completion approval passed through the live app. |
| Completion cleanup | Live green | A full-ID agent CLI request routed only to the task-owning remote after restart, appeared in native iOS, and returned to Work after approval. The task persisted as completed while its tmux session, socket claim, worktree, and branch were removed; the root task stayed intact. |
| Native review navigation | Code green | Task Info Changes and pull-request rows now push the existing native Diff and PR Status destinations while preserving the originating task stack. Unit, app, and repository gates pass; final connected visual QA remains. |
| TestFlight workflow | Account boundary | Unsigned Release validation and metadata checks pass. Signed archive/export tooling now rejects mismatched team, application ID, or default Keychain group; the first real archive and upload require the owner's Apple account configuration. |

## Selected v1 release gates

- Run final connected visual QA for the new Diff and PR Status navigation.
- Create and verify the first Apple-signed archive, then upload it through Xcode Organizer after the
  owner provides the Team ID, confirms the final bundle ID, signs into Xcode, and approves 2FA.
- Answer App Store Connect export-compliance questions and install the processed TestFlight build.

## Deferred after core-value validation

- Settings polish: appearance, terminal default, and About.
- The extended resilience matrix, accessibility/device pass, and performance measurements beyond the
  core-flow evidence already recorded.
- Agent Cockpit and other non-v1 surfaces.
- An agent-run physical-keyboard pass. The unit-covered Shift sequences will instead be included in
  the owner's smoke test on the TestFlight build.

## Recorded evidence

- `ios/qa-output/critical-running-task-e2e-part1.mp4`: creation, terminal input, metadata, navigation, zoom attempt, and cold continuity; it captures the device/instance theme mismatch found during QA.
- `ios/qa-output/critical-running-task-e2e-part2.mp4`: fixed cold bootstrap and exact same-PTY reattachment.
- `ios/qa-output/critical-running-task-e2e-part3.mp4`: diagnostic Light-device/Dark-instance comparison that rejected the false backing-raster workaround.
- `ios/qa-output/critical-running-task-e2e-part4.mp4`: corrected theme and zoom, required Description affordance, raw input, and reversible pane/window lifecycle.
- `ios/qa-output/critical-running-task-e2e-part5.mp4`: same-process Home-to-foreground recovery and corrected remote-server restart recovery, retaining the durable tmux session and worktree; `ios/qa-output/critical-remote-recovered-terminal.png` captures the restored terminal.
- `ios/qa-output/critical-running-task-e2e-part6.mp4`: task-owner routing, native completion approval, cleanup, and return to Work; `ios/qa-output/part6-approval.png` and `ios/qa-output/part6-final.png` capture the approval and final state.
- `ios/qa-output/critical-task-info-matrix.mp4`: title, overview, status/custom-column, watch, labels, notes, branch, and PR round trips; `ios/qa-output/task-info-matrix-green.png` captures the final matrix state.
- `ios/qa-output/critical-task-info-destructive.mp4`: native cancel and delete confirmations plus cleanup; `ios/qa-output/task-info-native-cancel-confirm.png` and `ios/qa-output/task-info-native-delete-confirm.png` capture both gates.
- `ios/qa-output/keychain-cold-launch-34018.log`: an intentionally unsigned/linker-signed QA artifact lacks Simulator application identity and cannot validate Keychain persistence. A normal Xcode-installed build restored the trusted session; signed archive entitlement assertions are the release gate.

## Verification baseline

- Dev3Kit: 94 tests passing.
- Dev3UI: 107 tests passing.
- Dev3TerminalKit: 33 tests passing.
- App CI: 47 tests discovered, with 46 passing and the opt-in live integration test skipped.
- Focused iOS raw-input regressions pass for exact carriage-return delivery, input-state clearing, and Ctrl-latch consumption.
- SwiftFormat and strict SwiftLint are clean for tracked iOS sources.
- Backend lint and all 5,801 fast mainview, Bun, and CLI tests pass at the current gate.
