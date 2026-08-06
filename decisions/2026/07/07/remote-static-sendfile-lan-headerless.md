# 113 — Remote static server: materialize file bodies to dodge Bun's LAN sendfile bug

## Context

The Remote Access server (`src/bun/remote-access-server.ts`) serves the built UI
to any browser. Over the Cloudflare tunnel it worked; over **direct LAN**
(`http://<lan-ip>:<port>`) the page rendered as a blank dark screen — our CSS
loaded (hence the "blue, our color" background) but React never mounted.

## Investigation

Reproduced with `dev3 remote --no-tunnel` + a headless browser pointed at the
machine's LAN IP (not `localhost`, which is a secure context and hides the bug):

- `assets/index-*.js` (the 2.7 MB main bundle) failed with
  `net::ERR_INVALID_HTTP_RESPONSE`; every smaller asset loaded fine.
- Raw TCP dump: the big JS response arrived as a **bare body with no HTTP status
  line or headers** (`curl` reported `Received HTTP/0.9 when not allowed`); the
  114 KB CSS arrived as a normal `HTTP/1.1 200`.
- Same file, same code, differing only by client route:
  - over `127.0.0.1` / `localhost` → correct headers;
  - over the LAN interface → header-less body.
- A 4-way harness confirmed the trigger: `new Response(Bun.file(...))` is BAD
  (with or without an explicit `Content-Length`); `new Response(await
  file.bytes())` / `.arrayBuffer()` is OK.

Root cause: passing a `Bun.file` blob as the response body lets `Bun.serve`
(Bun 1.3.14, macOS) use the zero-copy `sendfile(2)` fast-path for large bodies.
On a real (non-loopback) network socket that path emits the file body **without
the HTTP response head**, so the client rejects it. Loopback is unaffected —
which is exactly why the Cloudflare tunnel (its `cloudflared` origin dials
`localhost`) always worked and only direct LAN access broke.

## Decision

In `serveStatic`, read the file into memory (`await file.bytes()`) and return
`new Response(body, …)` instead of handing `Bun.serve` a raw `Bun.file`. This
bypasses `sendfile` entirely, so the response head is always written. The HTML
branch already materialized its body (`await file.text()` for theme injection),
so it was never affected. `serveStatic` also gained an optional
`staticRootOverride` param purely for hermetic unit testing.

## Risks

Each static request now allocates the whole file in memory (largest shipped
asset ≈ 2.7 MB). This is a single-user local/remote dev server, not a
high-traffic origin, so the memory cost is negligible and the correctness win is
absolute. If Bun later fixes the sendfile framing bug we can revisit, but the
in-memory path is safe regardless.

## Alternatives considered

- **Explicit `Content-Length` on the `Bun.file` response** — still triggered the
  broken sendfile path (verified BAD). Rejected.
- **Range/streaming via `ReadableStream`** — more code, still risks the
  fast-path, no benefit at these file sizes. Rejected.
- **Only tunnel access (drop LAN)** — LAN + QR is a first-class documented flow;
  not acceptable.
