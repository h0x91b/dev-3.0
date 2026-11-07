# Board-view extensions: loading, shared modules and trust

## Context

Board views task 7 (spec `board-views-spec.md` §4.3, D10–D12, D16, D24) lets third-party folders under
`~/.dev3.0/extensions/<id>/` contribute board views. The bundle must get dev3's own React and Cordis, run in the
desktop webview (`views://`) and in remote browsers, and never run without consent or from a remote session.

## Investigation

`ctx.plugin()` returns a thenable wrapper, not the fiber a plugin's context points at (`ctx.fiber`); only the value it
resolves to is that fiber, so ownership of a registered view can be checked only after the plugin started. Vitest
runs the bun suites under Node, so `Bun.semver` is unavailable there.

## Decision

- **Transport**: the renderer fetches the bundle text over RPC (`getExtensionSource`), which serves desktop and remote
  alike, and imports it from a `blob:` URL (`board-views/plugins.ts`). No new HTTP route, no auth surface.
- **Shared modules**: a static import map in `index.html` sends `react`, `react/jsx-runtime`, `react-dom` and
  `cordis` to `public/ext-shared/*.js` shims that re-export `globalThis.__dev3SharedModules`. Static, because a
  dynamically inserted import map is ignored once modules have loaded on older WebKit. The export lists are
  generated and guarded by `extension-shared-modules.test.ts`.
- **State**: a new sidecar `~/.dev3.0/extensions-state.json` (kill switch, built-in toggles, disabled ids, trust
  records), never `settings.json` — the renderer saves that file wholesale, and a remote session must not be able to
  write trust through it. Copying keeps only `dev3-extension.json` and `index.js`.
- **Desktop-only (D12)** is enforced in the host: the remote RPC path runs inside `runAsRemoteRpc`
  (`src/bun/rpc-origin.ts`, AsyncLocalStorage), and `rpc-handlers/extensions.ts` refuses every mutation from it except
  turning the kill switch off.
- **Ownership**: the registry refuses an id a *live* plugin already owns (a restarting or dying owner may replace,
  covering the StrictMode / disable-then-enable race), and the loader unloads an extension that registers an id its
  manifest does not declare.
- **Compat**: `engines.dev3` is matched against `EXTENSION_API_VERSION` (the board contract, `1.0.0`), not the app
  version, with a small npm-style matcher (`satisfiesRange`, `src/shared/extensions.ts`).

## Risks

No sandbox: consent, desktop-only install and the kill switch are the only defences. Blob-module imports through an
import map from a `views://` document are verified in Chromium; WKWebView relies on the same standard behaviour.
The shims must be regenerated when React or Cordis gains or drops an export (the test fails first).

## Alternatives considered

Serving bundles over a new HTTP route (needs auth on remote and a desktop server). Rewriting bare imports in the
bundle text (fragile regex over arbitrary JS). Storing trust in `settings.json` (writable from remote, clobbered by
wholesale saves). `Bun.semver` (unavailable under the Node test runner).
