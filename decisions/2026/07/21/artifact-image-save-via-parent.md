# 148 — Save artifact images via the parent frame, not the iframe

## Context
Shared HTML artifacts render inside `<iframe sandbox="allow-scripts">` (opaque origin,
no `allow-same-origin`, no `allow-downloads`). Right-clicking an image used the native
WKWebView "Save Image As…", which the sandbox blocks — it did nothing or saved to an
unclear cache location. Users expected the image in `~/Downloads`.

## Decision
Inject a small "Save image" context menu into the composed artifact document
(`composeArtifactDocument` in `src/mainview/utils/artifactDocument.ts`). On right-click
over an `<img>` it `preventDefault()`s the native menu and `parent.postMessage(...)`s the
image's data URL + alt to the viewer. `TaskArtifactViewer.tsx` accepts the message only
when `event.source === frameRef.current.contentWindow`, resolves the original file name
from the loaded assets, and reuses the existing `downloadBase64` anchor path — the same
mechanism as the header "Download artifact" button, which Electrobun lands in `~/Downloads`
(browser default in remote mode).

## Risks
The menu lives inside the sandboxed document, so it cannot use app Tailwind tokens — it is
styled inline against the injected `--dev3-*` theme variables. Only data-URL images are
saveable (CSP `connect-src 'none'` blocks fetching remote refs anyway).

## Alternatives considered
- Add `allow-downloads` to the sandbox and download from inside the iframe — rejected: WKWebView still picks the destination (the "unclear location" problem) and it widens the sandbox.
- New RPC that writes to `~/Downloads` in the bun process — rejected: in remote mode the bun process is on the remote host, so the file would not reach the user's machine.
