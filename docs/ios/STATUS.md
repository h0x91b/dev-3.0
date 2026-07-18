# Native iOS companion status

Last updated: 2026-07-18

This is the live execution status for [IMPLEMENTATION.md](IMPLEMENTATION.md). It tracks evidence and remaining gates; the implementation plan remains the scope and acceptance-criteria source of truth.

## Core flow

| Area | State | Evidence / next gate |
|---|---|---|
| Pair and reconnect | Code green; device recheck required | Fresh manual pairing, saved-session cold launch, one refresh/RPC connection/refetch, and no immediate reconnect churn passed before the TestFlight upload. Two QR-only regressions were then found on device. Decision 145 exchanges the single-use 30s token immediately on scan and surfaces rejections; decision 146 stops the `/instance` retry loop, explains that an older desktop must be updated, and adds an exportable redacted Diagnostics screen. Both fixes are unit-covered at `7468daf6`, but they postdate TestFlight `1.0.0 (1)` and need a new build plus a compatible desktop for final device verification. |
| Browse and create | Live green | Work/Projects navigation, one task creation, agent/config selection, preparation, and terminal handoff passed. Simulator accessibility and visual QA confirm the required Description affordance. |
| Running-task terminal | Live green | Composer and raw accessory input, exact agent responses, zoom, pane/window lifecycle, task metadata update, and cold PTY continuity passed. The terminal follows the instance theme, raw Enter clears UIKit input state, and hardware-key sequences are unit-covered. |
| PTY recovery | Live green | Cold reattach, true Home-to-foreground recovery with the same app PID, and remote-server interruption recovery all retained the same durable tmux session and worktree. |
| Task Info | Live green | Title save/reset, owner overview, built-in and custom status moves, watch, labels, notes, branch/PR refresh, priority, cancel cleanup, Todo deletion, and native completion approval passed through the live app. |
| Completion cleanup | Live green | A full-ID agent CLI request routed only to the task-owning remote after restart, appeared in native iOS, and returned to Work after approval. The task persisted as completed while its tmux session, socket claim, worktree, and branch were removed; the root task stayed intact. |
| Native review navigation | Live green | Task Info opens native Diff and PR Status. PR #969 rendered its merge state and four passing checks; Back returned to the exact task and rendered fresh PTY output. A mounted 34,000-file Diff repopulated after a same-server restart, then Back restored the exact connected terminal and fresh output. |
| Native transport limits | Live green | Native RPC receives are capped at 192 MiB and PTY frames remain capped at 1 MiB. Oversized frames fail explicitly instead of truncating; the validated large Diff loads within the RPC policy. |
| TestFlight workflow | Pipeline green; new build required | Xcode 26.6 cloud-signed and uploaded `1.0.0 (1)` without a registered device or local distribution identity. Compliance, Internal-group assignment, and the owner invitation are complete. That build predates decisions 145 and 146, so it is not the current release candidate; upload the next build from `7468daf6` or later. |

## Original-plan reconciliation

All Phase 0–3 v1 surfaces are implemented. Of the 23 implementation-plan tickets, 16 meet their
implementation and recorded acceptance scope, six are partial or still need a documented acceptance
pass, and T4.3 is deliberately deferred.

| Plan area | State | Remaining scope |
|---|---|---|
| T0.1–T0.4 foundations | Complete | None for v1: scaffold/CI, protocol contract, generated themes, `/instance`, Bonjour, and long-lived native sessions are present. |
| T1.1–T1.3 and T1.5 core transport/pairing | Implemented | Re-run the real QR path on a physical device using the current iOS code and a desktop that serves `/instance`. |
| T1.4 terminal engine | Partial acceptance | SwiftTerm, input, zoom, selection, clipboard, coalescing, and theme behavior exist; the documented 5k-chunks/sec measurement is part of the deferred performance pass. |
| T2.1–T2.3 and T2.5 shell, boards, Task Info | Complete | No known v1 implementation gap. |
| T2.4 running-task terminal | Core live green | Pane/window, input, zoom, recovery, and shared-size behavior passed live QA. Physical-keyboard validation and producer-bound PTY backpressure remain. |
| T3.1–T3.4 create/review/media | Complete | Diff is the planned read-only v1; inline comments/XML review export and card terminal previews remain v1.1. |
| T3.5 notifications | Implemented; live acceptance partial | Delivery, preferences, badges, dedupe, haptics, and deep links are tested in code; the background-connected delivery/tap-through acceptance is not recorded as live device QA. |
| T4.1 resilience | Partial | Foreground and server-restart recovery passed; airplane mode, Wi-Fi-to-cellular, tunnel-origin change, token expiry, and concurrent-client cases remain. |
| T4.2 settings and polish | Partial/deferred | Branding and partial accessibility/haptics exist. Manual appearance override, terminal default, About, and the full accessibility/device pass remain. |
| T4.3 performance | Deferred | Flood benchmark, five-board/three-terminal memory ceiling, and board-pager hitch measurements. |
| T4.4 TestFlight | Pipeline complete; release incomplete | Upload current code, install it, and complete the device smoke test. |
| Repository verification | Isolation-sensitive | `bun run test` currently fails in the complete fast suite even though all four affected files pass individually; restore the repo-required full-suite green gate before push/PR. |

Fast-follows remain B3 independent-size PTY, B4 named tunnels, future APNs, the v1.1 review/preview
features, and the v2+ surfaces listed in [DESIGN.md](DESIGN.md).

## Capability clarifications

- **Dark mode:** native chrome has generated dark and light palettes and follows the iPhone system
  appearance. The terminal intentionally follows the connected dev3 instance theme. The missing piece
  is an in-app manual appearance override.
- **Diff:** the native read-only v1 Diff is complete: uncommitted, branch, unpushed, and recent-commit
  modes; unified syntax-highlighted rendering; file stats; skipped-file details; and persistent local
  read state. Open a task's **Task Info**, then tap **Changes**. Inline comments and XML review export
  remain v1.1.
- **tmux panes and windows:** live QA covered splitting to three panes, selecting panes, closing back to
  one, creating a second window, and returning. Panes are a one-at-a-time carousel: swipe horizontally,
  tap previous/next, or tap a pane dot. Windows use previous/next plus an indexed menu. Selection and
  zoom operate on the shared tmux session, and external changes can take up to the three-second poll
  interval to appear. Native automated multi-pane UI coverage remains shallow. Scrollback: a vertical
  drag now scrolls tmux history — SwiftTerm's own scrollback is empty under tmux, so the drag is
  synthesized into SGR wheel events that tmux (`mouse on`) reads (decision 147). Needs on-device QA.

## Selected v1 release gates

- Run a compatible desktop from this branch (or a later release) that serves `/instance`.
- Upload a new TestFlight build from `7468daf6` or later; `1.0.0 (1)` predates both QR-pairing fixes.
- Restore a green end-to-end `bun run test`; the current six full-suite failures pass when their four
  files run individually, so this is an unresolved suite-isolation/load issue rather than four
  independently reproducible failures.
- Install the new build and smoke-test real QR pairing, reconnect, task creation, terminal input and
  pane/window navigation, Diff/Back, notifications, completion, and the physical keyboard.

## Deferred after core-value validation

- Settings polish: appearance, terminal default, and About.
- The extended resilience matrix, accessibility/device pass, and performance measurements beyond the
  core-flow evidence already recorded.
- Agent Cockpit and other non-v1 surfaces.
- An agent-run physical-keyboard pass. The unit-covered Shift sequences will instead be included in
  the owner's smoke test on the TestFlight build.
- Server-side pagination, chunking, or streaming for RPC and media payloads beyond the bounded native
  policy. The 192 MiB RPC limit is a client safety ceiling, not a universal server response limit.
- Producer-bound backpressure for `PTYClient.output`, whose upstream `AsyncStream` remains unbounded
  before the 4 MiB handoff relay and backpressured render buffer.

## Recorded evidence

- `ios/qa-output/critical-running-task-e2e-part1.mp4`: creation, terminal input, metadata, navigation, zoom attempt, and cold continuity; it captures the device/instance theme mismatch found during QA.
- `ios/qa-output/critical-running-task-e2e-part2.mp4`: fixed cold bootstrap and exact same-PTY reattachment.
- `ios/qa-output/critical-running-task-e2e-part3.mp4`: diagnostic Light-device/Dark-instance comparison that rejected the false backing-raster workaround.
- `ios/qa-output/critical-running-task-e2e-part4.mp4`: corrected theme and zoom, required Description affordance, raw input, and reversible pane/window lifecycle.
- `ios/qa-output/critical-running-task-e2e-part5.mp4`: same-process Home-to-foreground recovery and corrected remote-server restart recovery, retaining the durable tmux session and worktree; `ios/qa-output/critical-remote-recovered-terminal.png` captures the restored terminal.
- `ios/qa-output/critical-running-task-e2e-part6.mp4`: task-owner routing, native completion approval, cleanup, and return to Work; `ios/qa-output/part6-approval.png` and `ios/qa-output/part6-final.png` capture the approval and final state.
- `ios/qa-output/critical-task-info-matrix.mp4`: title, overview, status/custom-column, watch, labels, notes, branch, and PR round trips; `ios/qa-output/task-info-matrix-green.png` captures the final matrix state.
- `ios/qa-output/critical-task-info-destructive.mp4`: native cancel and delete confirmations plus cleanup; `ios/qa-output/task-info-native-cancel-confirm.png` and `ios/qa-output/task-info-native-delete-confirm.png` capture both gates.
- `ios/qa-output/critical-review-navigation.mp4`: the first live Changes-to-Diff pass exposed URLSession's 1 MiB default receive ceiling and its reconnect loop; `ios/qa-output/review-diff-message-too-long.png` captures the failure.
- `ios/qa-output/critical-review-navigation-fixed.mp4`: the endpoint-scoped transport fix rendered 20,994 files and returned to Task 194 with Pane 1 of 3 preserved; `ios/qa-output/review-diff-fixed-loaded-15s.png` and `ios/qa-output/review-diff-fixed-back.png` capture both states.
- `ios/qa-output/targeted-deeplink-discriminator-dc00.mp4`: the exact final discriminator on `dc00251d`; direct Task 194 routing, mounted Diff recovery after a scoped verifier restart, Back to the connected terminal, and fresh post-Back output all passed. `ios/qa-output/discriminator-dc00-diff-recovered.png`, `ios/qa-output/discriminator-dc00-back-connected.png`, and `ios/qa-output/discriminator-dc00-back-marker-visible.png` capture the release states.
- `ios/qa-output/keychain-cold-launch-34018.log`: an intentionally unsigned/linker-signed QA artifact lacks Simulator application identity and cannot validate Keychain persistence. A normal Xcode-installed build restored the trusted session; signed archive entitlement assertions are the release gate.

## Verification baseline

- Dev3Kit: 104 tests passing.
- Dev3UI: 119 tests passing.
- Dev3TerminalKit: 44 tests passing in isolation. The overflow/reset recovery test has twice failed
  under concurrent cold-build load and passed unchanged on immediate isolated reruns.
- App CI: 52 tests discovered, with 51 passing and the opt-in live integration test skipped.
- A concurrent all-suites stress run produced one non-repeating raw-input app-test failure; the full
  isolated app-scheme rerun passed 51/51 applicable tests.
- Focused iOS raw-input regressions pass for exact carriage-return delivery, input-state clearing, and Ctrl-latch consumption.
- SwiftFormat and strict SwiftLint are clean for tracked iOS sources.
- Backend lint is clean. The complete fast suite currently reports 5,795 passing, six failing, and one
  skipped across 5,802 tests. All four affected files pass individually and sequentially (65/65),
  isolating the remaining problem to full-suite load/shared-data interference; this gate is not green.
