# Hold startup RPCs until the bridge socket opens; close a browser socket that drops a packet

## Context
Two shipped symptoms had been patched at the edges without a root cause: App's startup `getGlobalSettings` never answered (#2151 — the placeholder was later saved over settings.json) and ProjectView's `getTasks` never settled (#2147). Both promises hung instead of rejecting, and their callers swallowed or waited on them.

## Investigation
- Host logs (~/.dev3.0/logs, 2026-10-19..11-01): every `→ getGlobalSettings` / `→ getTasks` that reached a handler has its `←`, so handlers do not hang — the loss is in transport.
- Desktop: Electroview sends over its WebSocket only when it is OPEN, otherwise through `window.__electrobunBunBridge.postMessage`. In electrobun 1.18.1 `nativeWrapper.mm` (`MyScriptMessageHandler`) that path `strdup`s the body, queues a threadsafe JSCallback onto the bun thread, and `free`s the copy after a fixed 1 s. A bun thread busy for over a second reads freed memory (`bunBridgePostmessageHandler` returns early on an empty string, or fails JSON.parse) and the request is gone with no response and no rejection. The pre-socket window is exactly startup, when App/ProjectView fire their first reads.
- Browser: Bun's `ServerWebSocket.send` returns 0 and discards the packet once the outgoing buffer is over `backpressureLimit` (16 MB default) — measured on Bun 1.3: three 6 MB sends return -1, every later send (a tiny response included) returns 0 and never arrives. `remote-access-server.ts` ignored the return value. Also `remote-session` detaches a socket before closing it on expiry, so `onSocketClosed` never fired and in-flight requests waited out the 6-minute cap.

## Decision
- `src/mainview/bridge-send-gate.ts` + `holdMessagesUntilBridgeSocketOpens` in `rpc.ts`: while the Electrobun socket is CONNECTING, messages are held and flushed through the socket on `open`; only if no socket opens within 5 s do they fall back to the native bridge. Re-inits (watchdog, Retry) are covered by wrapping `initSocketToBun`.
- `src/bun/rpc-socket-send.ts`: every remote RPC response/push goes through `sendRpcPacket`; a dropped packet on an open socket closes it with 4008, so the client rejects in-flight requests, reconnects and refetches. `onExpired` in `rpc.ts` now rejects sent requests.
- `src/mainview/startup-read.ts`: mount-time reads that leave the UI on a placeholder race a 10 s per-attempt timeout, retry (1 s/3 s/10 s), and record to Diagnostics instead of `.catch(() => {})`.

## Risks
The gate monkeypatches Electroview's `bunBridge`/`initSocketToBun` instance methods — an electrobun upgrade that renames them breaks the gate silently (the existing transport tests mock both). Retrying is only safe for idempotent reads; writes are not wrapped.

## Alternatives considered
Patching electrobun's native free delay (needs a native rebuild we do not ship); `closeOnBackpressureLimit: true` on the whole server (would also kill PTY proxy sockets); per-call-site timeouts only (#2147-style — treats the symptom, every new caller re-learns it).
