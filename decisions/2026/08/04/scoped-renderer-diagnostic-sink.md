# 199 — A scoped renderer→backend diagnostic sink, and what it cannot see

## Context

A native task froze its whole UI on Stop Dev Server. The backend was demonstrably fine —
`stopDevServer` finished in 539 ms and the main process kept logging for another 49 s —
while the renderer went silent. Diagnosing that from `~/.dev3.0/logs` was impossible,
because the renderer's console never reaches those logs.

## Investigation

The only renderer lines in the entire incident came from a helper added for an unrelated
terminal-copy investigation and marked `TEMP DIAGNOSTIC`: everything else the renderer
knew existed solely in a console nobody was watching, including the RPC bridge watchdog
deciding the bridge was dead. Reading the logger also showed why a naive fix would not
work: prod, staging and canary resolve to a minimum level of `info`, so a `debug` line is
dropped before it is ever appended.

## Decision

`logRendererEvent` becomes `logRendererDiagnostic`: a **scoped** sink, documented on its
schema entry in `src/shared/types.ts` and implemented in `src/bun/rpc-handlers/shared.ts`,
where `tag` namespaces each caller. It is not a general console bridge and must not become
one — each call site is a named investigation, expected to be deleted when that
investigation closes; four exist today (`terminal-copy`, `dev-server`, `rpc-watchdog`,
`terminal-dispose`), with `src/mainview/dev-server-trace.ts` as the reference shape.
Volume and level are the caller's problem: a `checkDevServer` poll emits only when it
stalls or rejects, and anything meant to be durable must be `info` or higher.

## Risks

**The sink is itself an RPC, so it cannot report a dead bridge.** When the transport stops
carrying traffic the traces stop with it, so no line emitted this way can *prove* bridge
death — only bracket it, by the last correlation id present on either side. A
transport-independent boundary would be needed for proof and is not built; a second risk
is that a promoted helper invites unrelated callers, mitigated only by review.

## Alternatives considered

A 1 Hz renderer heartbeat with global per-RPC logging was rejected as too noisy and too
cross-cutting to land on suspicion — it would write forever to catch an event seen once.
A second sink alongside the terminal-copy helper was rejected because two identical
bridges under different names is worse than one named honestly. Deleting the sink and
relying on the console was rejected: the console is exactly what was missing here.
