# 126 — Replace mobile WebSockets after resume

## Context

Mobile browsers suspend JavaScript and networking when the screen closes. On resume, a WebSocket can remain reported as `OPEN` or `CONNECTING` without delivering another close event, while the PTY client previously treated any close as a permanent session end and the RPC client could lose requests created between close and reconnect.

## Investigation

Deterministic renderer tests reproduced both failures: `TerminalView` created no replacement socket after a `1006` close, and an RPC request created during the reconnect delay was never sent after the replacement opened. The RPC loss came from awaiting a previously resolved socket-ready promise, while the PTY had no reconnect path at all.

## Decision

`src/mainview/rpc.ts` queues unsent request packets until the current socket opens, deduplicates reconnect timers, ignores events from replaced sockets, and replaces stale sockets on `visibilitychange`, `pageshow`, and `online`. `src/mainview/TerminalView.tsx` applies the same lifecycle triggers with bounded backoff, preserves one set of terminal input subscriptions, and reserves the permanent session-ended state for clean `1000` closes.

## Risks

Returning from the background intentionally replaces even an apparently open socket, so an in-flight RPC request can reject and be retried by its caller. This is preferable to trusting a mobile socket whose browser-visible state can be stale indefinitely.

## Alternatives considered

Relying only on reconnect timers was rejected because mobile browsers throttle or freeze them in the background. Reloading the task screen was rejected because it discards renderer state and hides the transport bug instead of recovering both connections in place.
