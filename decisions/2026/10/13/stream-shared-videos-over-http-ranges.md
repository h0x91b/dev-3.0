# Stream `dev3 show-video` clips over HTTP range requests

## Context
The video cap was held at the 25 MB image cap because a clip reached the viewer as one base64 `readImageBase64` RPC answer (~1.34× its size), decoded into a `blob:` URL — in the desktop bridge and over the remote tunnel alike. A 300 MB cap on that road means a ~400 MB string per open plus a second full copy in the renderer.

## Decision
`src/bun/shared-video-stream.ts` mints a random capability token per stored clip (`getSharedVideoUrl` RPC, only for files directly inside `~/.dev3.0/worktrees/<slug>/shared-images/`) and serves `/shared-video/<token>` with `Range`/206/416 support. A 206 is an in-memory slice of at most 8 MiB with an exact `Content-Length` (Bun drops that header from a stream body and answers chunked, which WebKit's media loader is pickier about); a plain 200 streams the file 1 MiB per pull. Desktop gets `http://127.0.0.1:<ptyPort>/…` from the PTY server (loopback-only check, CORS `*` so the Download button's `fetch` works from `views://`); remote mode gets the same path on the remote server behind the session cookie. `saveSharedVideo` copies asynchronously into a `.partial` sibling and renames only once the byte count matches. Images keep their 25 MB cap and base64 road.

## Risks
The PTY server listens on all interfaces; the route relies on the loopback check plus a 192-bit token. Tokens live for the process (capped at 256). Download still materialises the clip as a Blob, but only on an explicit click. A stream body is used on purpose — a `Bun.file` body would take Bun's sendfile path, which drops headers on macOS LAN sockets (`decisions/2026/07/07/remote-static-sendfile-lan-headerless.md`).

## Alternatives considered
Raising the constant alone (400 MB IPC strings per open). Chunked RPC reads assembled into a Blob (no giant string, but the full clip in renderer memory before playback and no seeking until done). A custom `views://` handler (desktop only, nothing for remote mode).
