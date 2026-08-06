# 172 — Native terminal viewers over the existing PTY WebSocket

## Context

A task terminal on the native backend (seq 1292) streams through `pty-server`'s
WebSocket bridge, which remote mode already proxies at `/pty?session=…`. Two
things tmux gave that bridge for free are missing natively: tmux repaints its
pane for any newly attached client, and tmux arbitrates several attached clients
itself. So a browser tab attaching to a live native session showed a blank
screen, and every viewer could type into the one PTY at once.

## Investigation

The native host already replays its bounded journal to a newly attached client,
but the app holds ONE client per session and multiplexes every viewer through it
— so that replay only reaches viewers connected at that instant. `capturePane`
returns null for native, and the tmux redraw jiggle in `applyClientSizes` only
resizes a live shell without repainting a plain one.

## Decision

Mirror both missing pieces at the bridge, native-only
(`src/bun/native-terminal-bridge.ts`, wired in `src/bun/pty-server.ts`):

- `NativeBridgeJournal` — a byte-capped ring of the batches already broadcast,
  recorded even with zero viewers. `attachNativeClient` flushes pending output,
  then replays either the delta after the viewer's `since` watermark or the whole
  tail with an explicit reset, BEFORE the viewer joins the broadcast set.
- `NativeClientLease` — one writer among the viewers; observers' input is
  refused with an explicit `role` frame, and `applyClientSizes` sizes the PTY
  from the writer alone so a phone in portrait cannot shrink the writer's shell.

Framing is in-band on the same wire (`src/shared/native-terminal-stream.ts`):
one APC-wrapped JSON header per message, followed by raw terminal bytes. Remote
forwards the `since` param through its existing `/pty` proxy; no second server,
listener, or auth path is introduced.

## Risks

The journal is bounded (256 KB, matching the host's), so a viewer offline long
enough gets a rebuilt screen rather than full scrollback — reported as
`reset: "pressure"`, never as a silent gap. Framing costs one small JSON parse
per output batch (not per byte); the payload is never escaped.

## Alternatives considered

- **A second WebSocket/daemon speaking the host protocol straight to the
  browser.** Rejected: duplicates the authenticated remote transport and would
  put a second writer against the host.
- **A JSON envelope around the payload.** Rejected: escaping every output byte
  on the hot path, for no gain over an in-band header.
- **Reusing the host's parser-state snapshot as the attach screen.** Rejected
  here: the live parser is opt-in and semantic, while the bridge needs the raw
  bytes every viewer already renders. It remains the right source if native
  terminals later need a semantic capture surface.
