# File preview plays audio/video from `/file/` links, media-only on the desktop's loopback server

## Context
The terminal file preview (`FilePreviewModal`) read every non-image file over RPC and refused anything past 1 MB as "too large", so a 7 MB MP3 or any real video could not be previewed. Shipping media over RPC as base64 would hold whole files in memory on both sides and cannot seek.

## Investigation
Two Range-capable facilities already existed: the token-only `/file/` capability links (`src/bun/file-links.ts`, see `decisions/2026/10/17/remote-file-open-in-new-tab.md`), served by the remote server, and `/shared-video/` on the loopback PTY server, which the desktop's `views://` page already plays `dev3 show-video` clips from. `/shared-video/` only accepts clips stored under dev3's own storage, so it cannot carry an arbitrary previewed path. Both answer a 206 as a bounded in-memory slice because WebKit rejects a chunked 206.

## Decision
- `readFilePreview` (`src/bun/rpc-handlers/terminal-paths.ts`) returns `{ kind: "media" }` for audio/video extensions (`previewMediaKind`, `src/shared/file-link-types.ts`) without reading the file, at any size; the text cap is unchanged.
- `getFileMediaUrl` (`src/bun/rpc-handlers/app-handlers.ts`) calls `mintPreviewMediaLink`: the same path gate as `createFileLink`, plus "media by both the requested name and its real target", then a single-file `/file/` token. It returns the loopback PTY URL; the browser transport (`src/mainview/rpc.ts`) uses the bare path on its own origin, exactly like `getSharedVideoUrl`.
- The PTY server serves `/file/` loopback-only and with `serveFileLink(..., { mediaOnly: true })`, which 404s anything that is not `audio/*`/`video/*` (downloads included). That origin also hosts the PTY WebSocket, so a token minted for a page by the remote "Open in new tab" must never render there.
- `FilePreviewMedia.tsx` uses native `<audio>`/`<video controls preload="metadata">`, never autoplays, asks `canPlayType` before requesting a stream, reports the element's `error`, and on unmount or path change pauses, drops `src` and calls `load()` so the decoder and connection are released.

## Risks
- Codec support is the engine's: Chromium refuses QuickTime (`.mov`), WebKit plays it. A random-bytes `.mp3` is accepted by WebKit/AVFoundation as a valid file that never advances, with no `error` event — the player shows but stays at 0:00.
- The desktop path (`views://` page → `http://127.0.0.1:<pty>/file/`) mirrors `/shared-video/`, but was verified on the server side (curl) and in Playwright WebKit, not inside the Electrobun window itself.
- A media token is a 12 h capability like any `/file/` link; on the desktop it is reachable only from loopback.

## Alternatives considered
Base64 over RPC: unbounded memory and no seeking. Widening `/shared-video/` to arbitrary paths: duplicates the `/file/` scope pinning and identity checks. Serving every `/file/` token on the PTY server: would let an agent's HTML page render on the origin of the terminal WebSocket. A custom JS player: more code and weaker accessibility than the native controls.
