# The model proxy dies with the app

## Context

Routed agents retain their proxy address and local session key across app restarts. Deferred quit cleanup leaked proxies with provider credentials, while occupied ports made later starts choose new addresses and strand existing sessions.

## Investigation

Electrobun's `Utils.quit()` emits `before-quit` synchronously and then calls native shutdown and force-exit: a dynamic import or an awaited descendant scan cannot reliably signal the proxy first. The current `buildProcessTree()` uses cached `args` output and exposes no executable identity, so reclaim instead needs fresh `ps -eo pid=,ppid=,comm=` plus `lsof -a -p <pid> -Fn`, matching both runtime databases through the real directory path.

## Decision

`killModelSidecarNow()` in `src/bun/model-sidecar.ts` synchronously signals the running or starting child and blocks further starts; `src/bun/index.ts` imports and invokes it inline. Async RPC stops retain their port-release wait. `endpoint.json` adds optional `pid` and `ownerPid` fields without changing its location or the existing port/key fields; older readers and writers remain supported.

Startup reclaims only the address it will take, in the existing default-then-remembered order, and binds that reclaimed address first. A listener must match the proxy executable and both database paths, have no live non-init parent, and have no live recorded owner before `terminatePidsVerified` signals it; other ports and other instances are left untouched.

## Risks

Unknown identity or owner liveness fails closed, including permission errors and Windows without `ps`/`lsof`; PID metadata alone is not permission to kill. A port can still be taken between inspection and bind, and PID reuse during inspection cannot be eliminated without OS process handles. Existing agents on unselected legacy ports are not migrated, and the shared endpoint file cannot preserve every address across multiple instances.

## Alternatives considered

Adopting an orphan retains stale configuration and loses lifecycle/output ownership. Killing every orphan strands agents on addresses no replacement will serve, while trusting PIDs alone can kill unrelated processes after reuse. Async quit cleanup repeats the original race; a synchronous descendant scan delays quit unnecessarily for a proxy with no children.
