# Native multi-pane terminal session coordinator (seq 1283)

The native runtime slice of LAY-003 / LAY-004 / LAY-005: it composes the existing
persistent single-pane hosts (`../native-terminal-registry`) into one logical
multi-pane terminal session, with no tmux anywhere in the path.

**Not wired into any product surface.** No RPC handler, CLI command, or renderer
imports this module — an isolation test enforces that. tmux stays the production
default.

## Model

| Layer | Owner | Where it lives |
|---|---|---|
| Pane membership + geometry | shared | `SplitTree`, persisted in the coordinator record |
| Focus + zoom | each client | `CoordinatorClientView`, never persisted |
| PTY cols/rows, input | the host's writer | per-pane registry session |

One logical pane === one registry-owned host === one shell process. The pane's
registry session id is `<coordinatorId>-<paneId>`, so a fresh controller can
rediscover every host from the layout alone. Protocol v1 stays a single-PTY
contract — see [decision 169](../../../decisions/2026/07/25/one-host-per-pane-multipane-coordinator.md).

`SplitTree` carries `activePaneId`/`zoomedPaneId` because it was written for a
single renderer. `focus-mapping.normalizeSharedLayout` strips both before the
tree becomes shared state, and `directionalFocusTarget` borrows the tree's
geometry with a client's own focus temporarily installed — so directional focus
works without ever writing a client's focus back into shared state.

## On-disk state

Additive namespace `~/.dev3.0/native-multipane/<coordinatorId>/coordinator.json`
(override with `DEV3_NATIVE_MULTIPANE_DIR`). It is a sibling of — never inside —
the registry's `native-sessions/` root, and it never touches legacy tmux records.

The record is deliberately minimal: schema version, coordinator id, epoch,
`updatedAt`, the serialized `SplitTree`, and the pane→session bindings. Host pid,
shell pid, endpoint, ownership evidence, and PTY size are read from each pane's
own registry record instead of being duplicated.

Writes are tmp-write + rename. Removal is a compare-and-swap on `epoch`, so a
stale controller can never erase a coordinator that was torn down and recreated
under the same id. A record whose bindings disagree with its own layout, or whose
schema version is not this build's, is unreadable rather than half-adopted.

## Lifecycle

```ts
const coordinator = await NativeMultipaneCoordinator.create("demo", spec);
const paneId = await coordinator.split("pane-1", "horizontal", spec);
await coordinator.resizePane(paneId, 120, 40);   // writer-owned; observers are refused
await coordinator.closePane(paneId);             // kills only that pane's owned tree
await coordinator.cleanup();                     // idempotent full teardown
```

`recover(id)` is the fresh-controller path after an app-process restart: it never
spawns and never double-attaches. Panes whose host no longer verifies as ours are
reconciled out of the layout deterministically; when none survive it drops the
record and returns `null`. Closing the last pane tears the logical session down.

Two controllers may observe the same pane set. The host grants writer to the
first live attachment; a second controller attaches as observer, and
`resizePane`/`writePane` throw `ObserverMutationError` instead of silently
no-oping.

## Harness

`cli.ts` is a dev-only driver. Every command runs in a fresh process, so anything
after `create` exercises real recovery from disk:

```bash
bun src/bun/native-terminal-multipane/cli.ts create demo --panes 6
bun src/bun/native-terminal-multipane/cli.ts list demo          # same ids, same pids
bun src/bun/native-terminal-multipane/cli.ts split demo pane-3 --vertical
bun src/bun/native-terminal-multipane/cli.ts focus demo pane-1 right
bun src/bun/native-terminal-multipane/cli.ts zoom demo pane-2
bun src/bun/native-terminal-multipane/cli.ts resize demo pane-1 120 40
bun src/bun/native-terminal-multipane/cli.ts close demo pane-3
bun src/bun/native-terminal-multipane/cli.ts cleanup demo
```

## Tests

```bash
bunx vitest run --config vitest.config.bun.ts native-terminal-multipane
bun run test:native-multipane-e2e     # 2 and 6 REAL panes, detach/reconnect, cleanup
```

The e2e run proves independent shells (each echoes its own env marker and pid),
non-crossing output streams, client-local focus/zoom, writer-vs-observer resize,
fresh-process recovery of identical host/shell pids, single-pane close, full
teardown, and that tmux is never invoked (PATH shim sentinel).
