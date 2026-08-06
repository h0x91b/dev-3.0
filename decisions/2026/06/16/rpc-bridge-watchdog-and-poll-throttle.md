# 072 — RPC bridge watchdog + visibility-aware poll throttling

## Context

Users reported the app UI freezing: clicks register but switching tasks / opening
tmux does nothing, only a force quit recovers — while tmux and all child processes
keep running. Two distinct failure classes were identified from logs.

## Investigation

- **Type-2 (daytime, bridge jam).** The desktop transport in `src/mainview/rpc.ts`
  (`initElectrobunApi`) is just `Electroview.defineRPC({ maxRequestTime })` with no
  reconnect. Electrobun's `Electroview` (`node_modules/electrobun/dist/api/browser/index.ts`)
  talks to bun over a localhost WebSocket whose `close` handler is empty — after
  sleep it can drop, `send` silently falls back to a dead postMessage path, and every
  `api.request.*` hangs for the full timeout. The browser transport already reconnects;
  PTY uses a separate `ws://localhost/pty` socket, which is why terminals survive.
- **Type-1 (after-sleep, poll storm).** Each open task panel polled `getBranchStatus`
  every 15s (→ `git fetch` + `gh pr list` + many local git commands). On wake, all
  pending `setTimeout`/`setInterval` timers fired together — a thundering herd of git
  processes. `loop-monitor.ts` confirmed the bun loop itself was healthy during daytime
  freezes (max stall <1s), proving Type-2 ≠ Type-1.

## Decision

- Added a cheap `ping` RPC (`app-handlers.ts`) and a watchdog in `rpc.ts`
  (`startBridgeWatchdog`) driven by pure logic in `rpc-watchdog.ts`. It pings on a
  timer and on visibility/focus with a short timeout (independent of the 120s request
  timeout); on confirmed failure it calls `electroview.initSocketToBun()` to re-open
  the socket, and escalates to `window.location.reload()` (bun stays alive, so the
  bridge recovers without a force quit). A sessionStorage gap guards against reload loops.
- Added `src/mainview/utils/poll.ts` (`startVisibilityAwarePoll`): never ticks while
  hidden, runs one refresh on wake, jitters intervals. Wired into the backend-hitting
  pollers (`useTaskBranchStatus`, `GitPullButton`, `KanbanBoard` PR poll,
  `useResolvedTaskProject`, `TmuxSessionManager`).
- Added `src/bun/concurrency.ts` (`Semaphore`) capping concurrent heavy
  `getBranchStatus` runs at 4 (`git-operations.ts`).

## Risks

- `initSocketToBun()` is an Electrobun-internal method; an upgrade could rename it.
  The call is wrapped in try/catch and reload is the fallback, so a rename degrades
  to "reload-only", not a crash.
- A reload mid-work loses in-renderer UI state, but only fires when the bridge is
  confirmed dead — strictly better than the current force-quit.

## Alternatives considered

- Shorten `maxRequestTime` + auto-retry: masks the dead socket without reopening it.
- Reconnect only on `visibilitychange`: misses jams that occur without a visibility
  change; the periodic ping covers both.
- Per-call-site poll fixes instead of a shared helper: more churn, easy to miss a site,
  and no single place to tune jitter/visibility behavior.
