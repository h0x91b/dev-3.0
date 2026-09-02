# Per-window native title from the renderer's route context

## Context

Every dev-3.0 window carried the identical static title (`dev-3.0 vX.Y.Z [build]`) set once at
`BrowserWindow` creation. With multi-window (⇧⌘N) on several displays there was no way to tell which
window showed which task — not in the title bar, not in Mission Control, not in the Window menu
(issue #1632). The renderer already computed exactly the right string for `document.title`
(`App.tsx`, the route-title effect), but a webview's `document.title` does not propagate to the
native window in Electrobun.

## Decision

The renderer reports only the **context** (task title, project name, or the streamer-mode
placeholder) over a new RPC request `setWindowTitleContext`; the host composes the final title with
`composeWindowTitle(base, context)` (`src/bun/app-utils.ts`) and calls `BrowserWindow.setTitle`.

Two points worth knowing:

- **The handler is per window.** `createAppWindow` (`src/bun/window-manager.ts`) spreads the shared
  `handlers` object and overrides `setWindowTitleContext` with a closure over a back-reference to its
  own window. The shared handler cannot do it: it has no idea which window called, and routing
  through `getFocusedWindow()` would let a background window retitle the focused one. The closure is
  cleared on `close` so a late report cannot touch a dead window.
- **The renderer sends the context, not the whole title.** The host keeps ownership of the base
  (version + build time), which the renderer's own base title does not carry — forwarding the
  computed `document.title` would have silently dropped the build timestamp from dev window titles.

The remote transport dispatches from the shared `handlers`, so `app-handlers.ts` keeps a deliberate
no-op entry: a browser client already owns its tab title, and it must never retitle a desktop window.

## Risks

`setTitle` is wrapped in try/catch — a window torn down natively between the report and the call
would otherwise throw inside an RPC handler. Native titling is not covered by an automated test
(no headless desktop window); the routing, composition and teardown behaviour are.

## Alternatives considered

- **Global handler + `getFocusedWindow()`** — wrong window on every report from a background window.
- **Plumb a window id through `preload` and have the renderer pass it** — more moving parts and a new
  trust boundary for no gain over the closure.
- **Poll `document.title` from the host** — Electrobun exposes no such read, and polling would fight
  the effect that owns the value.
