# Remote file preview: open in a new tab via token-only capability links

## Context
The desktop file preview offers "Open in default app", which runs on the host. In browser/remote mode the host is WSL or a remote box, so the button was hidden and the only way to read a file was the in-app preview. Users want the file in their own browser tab (HTML reports, Markdown rendered by their own extension) or downloaded to their device.

## Investigation
Agent-written HTML served from the dev3 origin would run with the signed-in user's authority (RPC, terminals). Serving it with `Content-Security-Policy: sandbox` (no `allow-same-origin`) gives the page an opaque origin, but an opaque origin never sends the `SameSite=Strict` session cookie. So the page's own CSS/images cannot authenticate by cookie, and an HTML page's relative assets need the link to cover its folder.

## Decision
`createFileLink` (`src/bun/rpc-handlers/terminal-paths.ts`) gates the path exactly like `readFilePreview`, then mints a 24-byte token (`src/bun/file-links.ts`, 12 h TTL, 256 cap) scoped to the file's folder inside a worktree or project, or to the single file elsewhere (home, temp). `/file/<token>/<rel>` in `remote-access-server.ts` is token-only, like `/p/`. Every response has `nosniff`, `no-referrer`, `no-store`; HTML/SVG get the CSP sandbox; Markdown goes out raw as `text/markdown` so the browser or an extension decides; `?download=1` forces an attachment. The artifact viewer's remote "Open in browser" (`createArtifactLink`, `app-handlers.ts`) and the image/video viewer's and attachment card's open action go through the same links, replacing a `blob:` URL that ran the artifact with the dev3 origin's authority and lost its relative assets. "Open on Windows" (`src/bun/wsl-host.ts`) runs `explorer.exe` on the `wslpath -w` path, offered only when the server is under WSL and the page hostname is loopback (`src/mainview/file-open-browser.ts`).

## Risks
The URL is the credential for 12 h: anyone holding it can read that folder. No CORS headers are sent, so a sandboxed page cannot read sibling files with `fetch`, and module scripts and web fonts (both fetched in CORS mode) do not load in a report opened this way. A spoofed `Host` header only makes "Open on Windows" appear for the user's own session.

## Alternatives considered
Session-cookie auth on the route: breaks every subresource of a sandboxed page. Rendering Markdown to HTML on the server: rejected so users keep their own renderer. Serving HTML unsandboxed: gives an agent's page the user's dev3 session.
