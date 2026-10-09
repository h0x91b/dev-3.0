# Desktop bridge re-init replays pending approval dialogs

## Context

`decisions/2026/09/15/re-push-agent-approval-on-every-attempt.md` made `App.tsx` replay pending
completion/cancellation/launch requests on every `RPC_STATUS_EVENT` → `connected`, so a push lost
while the transport was down comes back. Re-checking h0x91b/dev-3.0#1669 on 2026-10-09 showed that
event only ever fires for the browser transport: the Electrobun desktop bridge seeds `connected`
once, before `App` mounts, and the bridge watchdog (`startBridgeWatchdog` in `src/mainview/rpc.ts`)
re-opens a dead socket without announcing anything.

## Investigation

The watchdog probes every 30 s, and on window focus/visibility; two failed pings → `reinit`. Every
push the host sent while the old socket was dead is gone, and on desktop nothing re-asked
`listPending*Requests` afterwards — a cancel requested during that window stayed invisible until a
page reload or an agent retry. The reporter ran the macOS desktop app and saw `dev3 ui state`
frozen (`foreground no`, stale `activeProject`), which matches a host that was not hearing from the
renderer — consistent with this gap, not proven: no logs from their machine.

## Decision

`decidePingOutcome` (`src/mainview/rpc-watchdog.ts`) returns `"recovered"` for the first live ping
after a re-init; `rpc.ts` then calls `setRpcState("connected")`, which drives the existing replay.
After a re-init the watchdog probes again in 1.5 s instead of waiting for the next 30 s tick. A
webview reload needs nothing — the mount replay already covers it.

## Risks

A redundant `connected` event re-runs three `listPending*` requests; every dialog dedups on
`requestId`, so nothing stacks. Consent policy is untouched.

## Alternatives considered

- **Announce right after `initSocketToBun()`.** Rejected: the new socket is still connecting and the
  replay's requests would fall into the dead path until the 6-minute RPC timeout.
- **Reload the webview on every re-init.** Rejected: throws away UI state to recover three requests.
