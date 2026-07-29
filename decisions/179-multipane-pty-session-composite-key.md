# 179 — Per-pane PtySession + composite key instead of a pane dimension in the Seq 1300 stream protocol

## Context

PR1 of "Wire native multi-pane into Task Terminal" (seq 1311) makes the native backend genuinely multi-pane. The pty-server WebSocket bridge (seq 1300) must be able to deliver one byte stream per pane, not one per task.

## Investigation

Three possible designs for how the renderer identifies which pane's stream it wants:

1. **Composite WS key** — `?session=${taskId}~${paneId}` for non-first panes; first pane keeps the bare `taskId`. Each PtySession gets its own NativeBridgeJournal and NativeClientLease. The stream format is unchanged.
2. **Pane dimension in the stream protocol** — extend the `?session=` query or the framing to include a pane id. All panes share one WS connection and one journal; the server multiplexes frames.
3. **Separate WebSocket endpoint** — one endpoint per pane, e.g. `?session=${taskId}&pane=${paneId}`.

Option 2 would require a protocol bump (seq 1300 is frozen; bumping it breaks every open renderer tab). Option 3 is functionally identical to option 1 but requires a new server-side dispatcher. Option 1 reuses every existing code path: attach/broadcast/resize/ownership logic are byte-identical for any PtySession regardless of which pane it backs.

## Decision

Option 1: per-pane PtySession with composite key `${taskId}~${paneId}`, shared module `src/shared/pane-session-key.ts`. The task's FIRST pane keeps the bare `taskId` key so every existing lifecycle path, `ptyDied` event, capture, and remote-proxy hop keeps working unchanged. Additional panes register under composite keys via `ensureNativePanePtySession`. The `~` separator is URL-safe (RFC 3986 §2.3 unreserved) so no percent-encoding is needed in the query string.

## Legacy single-view sweep

Before `startNativeTaskPanes` creates a coordinator, it checks whether a pre-migration single-view registry session whose id equals the bare coordinator id (`dev3-task-<uuid>`, no `-pane-N` suffix) is still present. If so it tears it down and logs loudly. This is the ONLY place the sweep happens. Skipping it would leave an invisible shell alive forever — the next coordinator create would find the id taken, and the orphaned host would hold the pty-server writer lease indefinitely.

## Coordinator-id length relaxation

The coordinator id pattern was capped at 32 chars. A real coordinator id is `nativeTaskSessionId(taskId)` = `dev3-task-<uuid>` = 46 chars. The derived pane session id `dev3-task-<uuid>-pane-N` (≤53 chars) must fit the terminal-backend seam's 64-char session-id rule. The cap was raised to 56 chars (46 + 10 chars of headroom), preserving the `..` rejection and the character class.

## Risks

- The composite-key sweep on teardown (`sweepNativePaneSessions`) iterates the full `sessions` map. Under normal workloads (≤20 tasks) this is negligible.
- If a pane's WS connection arrives before `ensureNativePanePtySession` registers it, the `open` handler logs a warning and the renderer retries on reconnect (same semantics as any missing session today).

## Alternatives considered

- Protocol extension: rejected (seq 1300 is frozen; any break affects remote mode clients).
- Separate endpoint: more routing code, no benefit over the composite key.
- Shared journal for all panes of a task: violates "one observer cannot resize or refocus another writer client" per pane.
