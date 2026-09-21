# dev3:// is the only non-web scheme the terminal will click

## Context

A `dev3://task/<id>` link printed in terminal output was dead text. Two independent gates
refused it, which is why "OSC 8 works for http" and "dev3 does not open" were both true at once:

- **Plain text.** Nothing in this repo linkifies URLs; ghostty-web's bundled `UrlRegexProvider`
  does, and its regex is a fixed list — `https?`, `mailto`, `ftp`, `ssh`, `git`, `tel`, `magnet`,
  `gemini`, `gopher`, `news`. A custom scheme is invisible to it, so no link was ever offered.
- **OSC 8 target.** `safeOsc8Uri` (`src/mainview/terminal-osc8-links.ts`) accepted http(s) and
  local `file:` URIs only, so a hyperlink whose target was a deep link resolved to nothing — the
  visible label stayed plain, regardless of which agent printed it.

## Decision

The terminal now detects and opens deep links itself, in the renderer, above the PTY transport —
so it is the same code on the tmux and the native backend, and in browser (remote) mode.

- `findDeepLinksInText` (`src/shared/deep-link.ts`) scans one line of text and keeps only matches
  `parseDeepLink` accepts, so the grammar stays in the single module that owns it.
- `createDeepLinkProvider` (`src/mainview/terminal-deep-links.ts`) is a second link provider
  registered next to the file-path one, reusing its logical-line reassembly (a task link is ~47
  characters and wraps), and its ranges also feed the persistent underline overlay.
- `safeDeepLinkUri` widens the OSC 8 allow-list by exactly one scheme, and only for URLs whose
  kind the app navigates. `activateDeepLinkUri` resolves the id through the new
  `resolveDeepLinkNav` RPC (the same `resolveDeepLink` the inbound `open-url` handler uses) and
  dispatches `rpc:openDeepLink`, which App.tsx already listens for.

**Deliberately not the OS handler.** Bouncing `dev3://` out through `Utils.openExternal` /
`window.open` would only work on macOS (the sole platform registering the scheme) and would
re-enter the app from the outside while the window is already open. In-app navigation is also
what makes the link work in remote/browser mode, where there is no OS handler at all.

**Deliberately one scheme, not "custom schemes".** Every other non-web scheme stays refused
(`javascript:`, `data:`, `vscode:`, `smb:`, …): terminal content is untrusted, and the only reason
dev3 can be trusted here is that activation never leaves the app — it resolves an id against the
local boards and navigates, so the worst case is a toast saying the target is gone.

## Risks

- A deep link now resolves against every project on the board on click (`loadTasks` per project).
  It is one RPC per click, not per render — detection is pure string work and never touches disk.
- Widening the OSC 8 allow-list is the security-sensitive edge. It is pinned by a test that
  asserts `javascript:`, `data:`, `vscode:` and `smb:` are still refused while `dev3://task/…`
  is accepted, so removing the narrowness fails the suite.

## Alternatives considered

- **Patch or replace the vendor's URL provider.** It is a bundled class with a private static
  regex; there is no hook, and forking it would own every protocol, not just ours.
- **Print the `https://dev3.h0x91b.com/open.html?task=…` twin instead** (the trick that makes PR
  footers clickable). It works, but it leaves the terminal via the browser and needs the scheme
  registered on the machine to come back — a worse click for something the app can answer itself.
- **Allow any scheme in OSC 8 and let the OS decide.** Rejected: that hands untrusted terminal
  output a channel into arbitrary OS handlers.
