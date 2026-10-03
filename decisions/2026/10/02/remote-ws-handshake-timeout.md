# Remote RPC socket gets a handshake timeout

## Context

A first browser load sometimes hung on the boot screen ("Connecting to your computer...") while the server log showed the auth exchange, an authorized `/rpc` upgrade and `Remote RPC client connected`, then no RPC traffic at all. Retry fixed it. The remote session machine (`src/mainview/remote-session.ts`) only reacts to a socket `close`, and a browser socket that never leaves CONNECTING never fires one.

## Investigation

One logged incident on a Windows browser reaching a WSL host via loopback forwarding. In that incident, the upgrade was accepted, the socket was silent for 101 s, and then came a disconnect plus an immediate re-upgrade with no `/auth/refresh` in between. That is `kick()`, the Retry button. A TCP proxy that swallows the server's 101 for the first `/rpc` upgrade reproduces it exactly on headless Chromium. The page stays stuck indefinitely, and Retry recovers it. Why the real 101 went missing (relay, browser) is not provable from the logs.

## Decision

`connect()` arms a `connectTimeoutMs` timer (default 10 s). If the socket is still the active one and has not opened, the timer detaches it, closes it, reports `onError`, and runs the normal close path (`handleClose`: probe `/auth/refresh`, then backoff or expire). `open` and `close` clear the timer.

## Risks

A legitimately slow handshake over a poor tunnel longer than 10 s is cut and retried with backoff instead of being waited out. It still connects on a later attempt, and requests queued before `open` are not lost because they are only flushed on open.

## Alternatives considered

Auto-pressing Retry from the boot screen: fixes only boot, not a reconnect that stalls the same way later. Fixing the transport: the stall is outside dev3 and could not be pinned down.
