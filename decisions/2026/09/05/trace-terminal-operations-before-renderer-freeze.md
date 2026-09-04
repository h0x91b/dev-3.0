# Trace terminal operations before a renderer freeze

## Context

Repeated native renderer hangs have no thrown exception. On 2026-09-05 at 01:06:19 the host watchdog recorded lost heartbeat; by the time a sample was requested, the app had restarted. Error-only breadcrumbs cannot identify an operation that never returns.

## Investigation

Reports on task 1755 include frozen JIT stacks reached through timers, animation callbacks and a WebSocket listener. Task 1797's 280 browser resize drags did not reproduce the native failure; the artifact document was not rewritten. See `reports/1797-artifact-resize-freeze.md` for measurements and limitations.

## Decision

`terminal-freeze-trace.ts` sends paired synchronous-operation boundaries to the local renderer log. Desktop uses Electrobun’s native `__electrobunBunBridge.postMessage` with its message packet format; the normal socket path awaits encryption and cannot send a just-enqueued marker after a synchronous JS wedge. Browser mode uses the existing diagnostic RPC sink. `TerminalView.tsx` arms a bounded capture on refit only when the explicit `freeze` debug channel is enabled; render and underline callbacks share the same trace. IDs distinguish nested operations and repeated refits; dimensions, lengths and durations are logged, never terminal content.

## Risks

Tracing adds RPC/file-log overhead and may change reproduction timing, so it is off by default and bounded to ten seconds and 2,000 spans per capture. Begin markers are posted to native IPC before the operation, but delivery is still asynchronous across processes: a missing end is a candidate, not proof. The raw message envelope is tied to Electrobun’s installed protocol and covered by a transport test. This is diagnostic instrumentation, not a fix or proof of platform failure.

## Alternatives considered

Logging only after operations would miss the never-returning callback. Always logging each frame adds avoidable steady-state cost. Automatic process sampling was not added: it needs separate attribution and lifecycle handling; a live `sample` plus Inspector pause remains the confirmation step.
