# 199 — A scoped renderer→backend diagnostic sink, and what it cannot see

## Context

A native task froze its entire UI when the user clicked Stop Dev Server. The backend
was demonstrably fine: `stopDevServer` finished in 539 ms, closed the pane, reaped 8
processes verified dead, left no stuck ports, and the main process kept logging for
another 49 s until the user quit. The renderer went silent instead.

Diagnosing that from `~/.dev3.0/logs` was impossible, because **the renderer's console
never reaches those logs**. The only renderer lines in the whole incident came from a
helper introduced for an unrelated terminal-copy investigation, explicitly marked
`TEMP DIAGNOSTIC`: `logRendererEvent`. Everything else the renderer knew — including
the RPC bridge watchdog deciding the bridge was dead — existed only in a console
nobody was watching.

## Decision

`logRendererEvent` is renamed to `logRendererDiagnostic` and promoted from a
single-investigation hack to a **scoped** sink, documented on its schema entry in
`src/shared/types.ts` and implemented in `src/bun/rpc-handlers/shared.ts`. `tag`
namespaces each caller (`terminal-copy`, `dev-server`, `rpc-watchdog`).

It is deliberately **not** a general console bridge and must not become one. Every
call site is a named investigation and is expected to be deleted when that
investigation closes. Three exist today; `src/mainview/dev-server-trace.ts` is the
reference shape for a new one.

Volume is the caller's problem, not the sink's. `dev-server-trace.ts` traces user
gestures always but a `checkDevServer` poll only when it fails — a poll runs every few
seconds for every open task, and tracing its happy path would bury the gestures it
exists to explain.

## Risks

**The sink is itself an RPC, so it cannot report a dead bridge.** This is the honest
limit of the whole approach: when the transport stops carrying traffic, the traces
stop with it. It is not useless — the last correlation id present on either side
brackets the moment delivery stopped, and the renderer console still holds the tail
for a live post-mortem — but no trace emitted this way can *prove* bridge death. A
durable, transport-independent boundary (a file the renderer can reach without RPC)
would be needed for that, and is not built.

Second risk: a promoted helper invites unrelated callers. Mitigated only by
convention and review, since nothing enforces the tag namespace.

## Alternatives considered

- **A 1 Hz renderer heartbeat plus global per-RPC logging.** Rejected as too noisy and
  too cross-cutting to land on suspicion alone: it would write to the log forever to
  catch an event seen once.
- **Leave `logRendererEvent` as the terminal-copy temp helper and add a second sink for
  Dev Server.** Rejected — two identical bridges with different names is worse than one
  named honestly.
- **Delete the sink and rely on the console.** Rejected: the console is exactly what
  was missing when the incident was investigated.
