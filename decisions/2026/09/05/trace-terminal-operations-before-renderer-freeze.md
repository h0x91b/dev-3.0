# Trace terminal operations before a renderer freeze

## Context

Repeated native renderer hangs have no thrown exception. On 2026-09-05 at 01:06:19 the host watchdog recorded lost heartbeat; by the time a sample was requested, the app had restarted. Error-only breadcrumbs cannot identify an operation that never returns.

## Investigation

Reports on task 1755 include frozen JIT stacks reached through timers, animation callbacks and a WebSocket listener. Task 1797's 280 browser resize drags did not reproduce the native failure; the artifact document was not rewritten. See `reports/1797-artifact-resize-freeze.md` for measurements and limitations.

## Decision

`terminal-freeze-trace.ts` sends paired synchronous-operation boundaries to the local renderer log. Both desktop and browser use the existing diagnostic RPC sink. An initial direct native bridge experiment was removed after two native Bun Worker crashes during user reproduction; see the report for crash timestamps. `TerminalView.tsx` arms a bounded capture on refit only when the explicit `freeze` debug channel is enabled; render and underline callbacks share the same trace. IDs distinguish nested operations and repeated refits; dimensions, lengths and durations are logged, never terminal content.

## Risks

Tracing adds RPC/file-log overhead and may change reproduction timing, so it is off by default and bounded to ten seconds and 300 spans per capture. The ordinary desktop RPC awaits encryption before sending, so the last begin marker may be lost when JS wedges. A missing end is a candidate, not proof; native process sampling remains necessary. This is diagnostic instrumentation, not a fix or proof of platform failure.

## Alternatives considered

Logging only after operations would miss the never-returning callback. Always logging each frame adds avoidable steady-state cost. Automatic process sampling was not added: it needs separate attribution and lifecycle handling; a live `sample` plus Inspector pause remains the confirmation step.
