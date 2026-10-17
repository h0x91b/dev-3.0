# Remote file preview: open in a new tab via token-only capability links

## Context
The desktop file preview offers "Open in default app", which runs on the host. In browser/remote mode the host is WSL or a remote box, so the button was hidden and the only way to read a file was the in-app preview. Users want the file in their own browser tab (HTML reports, Markdown rendered by their own extension) or downloaded to their device. The artifact viewer's and image/video viewer's open buttons had the same gap.

## Investigation
Agent-written HTML served from the dev3 origin would run with the signed-in user's authority (RPC, terminals). `Content-Security-Policy: sandbox` without `allow-same-origin` gives the page an opaque origin, but an opaque origin never sends the `SameSite=Strict` session cookie, so a page's own CSS and images cannot authenticate by cookie. A Markdown extension that renders raw HTML can inject script into any text document, so sandboxing only HTML is not enough.

## Decision
- `createFileLink` (`src/bun/rpc-handlers/terminal-paths.ts`) gates the path like `readFilePreview`, then mints a fresh 24-byte token per click (`src/bun/file-links.ts`, 12 h TTL, 256 cap evicting the least recently used). Only a page (HTML/SVG) strictly inside a task worktree or project checkout gets its folder — never a checkout root and never dev3's own storage (uploads, task folders), found by walking up to the nearest `.git`. Everything else, and every download (60 s TTL), is one file.
- The scope is pinned to real paths at mint time. Each URL segment must be one plain name (no `%2F`, `.`/`..`, empty, NUL; no `\` or `:` on Windows), the target must be inside the root as a string before any filesystem call, and its real path (`realpathSync.native`, which expands 8.3 names) must stay inside with no dot-file/folder other than the entry.
- `/file/<token>/<rel>` (`remote-access-server.ts`) is token-only, like `/p/`. Every response has `nosniff`, `no-referrer`, `no-store`. Everything rendered carries a CSP sandbox with scripts but no same-origin, forms or modals (no fake access-code prompt on the user's own host), except video and audio, whose media document runs no page script and refuses a sandbox. PDFs are only ever sent as attachments: a PDF viewer cannot run sandboxed. Markdown goes out raw as `text/markdown`, sandboxed. `?download=1` forces an attachment. Types live in `src/shared/file-link-types.ts`, shared with the renderer.
- The artifact viewer's remote "Open in browser" (`createArtifactLink`, `sharedArtifactLinkScope`) and the image/video viewer, lightbox and attachment card go through the same links, replacing a `blob:` URL that ran with the dev3 origin's authority and lost relative assets.
- "Open on Windows" (`src/bun/wsl-host.ts`) runs `Invoke-Item -LiteralPath` in PowerShell with the path in a WSLENV `/p` variable (explorer.exe splits arguments at commas), only for document/media types (`WINDOWS_OPEN_SAFE_EXTS`: the default verb runs scripts), only when interop is registered and the page hostname is loopback (`src/mainview/file-open-browser.ts`).

## Risks
- The URL is the credential for 12 h, and a page can read its own URL: anything the page leaks reaches whatever the token covers — its own folder at most, never a checkout root or dot-files.
- No CORS headers are sent, so module scripts, web fonts and `fetch()` of siblings do not load in a report opened this way; a page cannot reach `../` assets above its own folder either.
- Links are not tied to a session: they outlive sign-out until expiry or a server restart.
- "Same PC" is inferred from a loopback hostname: an SSH or VS Code port-forward to `localhost` also passes, and "Open on Windows" then opens on the forwarding host.

## Alternatives considered
Session-cookie auth on the route: breaks every subresource of a sandboxed page. Rendering Markdown to HTML on the server: rejected so users keep their own renderer. Serving HTML unsandboxed: gives an agent's page the user's dev3 session. One reusable token per folder: a leaked link would live as long as the user kept opening files there.
