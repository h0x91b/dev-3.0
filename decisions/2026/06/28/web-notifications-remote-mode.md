# 084 — Browser Web Notifications in remote mode

## Context

`dev3 notify --desktop` and watched-task banners call `Utils.showNotification`, which is a no-op stub in headless mode (`electrobun-platform.ts`). So when the UI is opened in a browser via `dev3 remote`, desktop-style notifications silently vanished — only the in-app toast path (`cliToast`) reached browsers.

## Decision

Mirror every native notification to browser clients as a new `webNotification` push event. The three `Utils.showNotification` call sites in `src/bun/rpc-handlers/shared.ts` (`notifyFromCliDesktop`, `notifyWatchedTaskStatusChange`, `notifyWatchedTaskEvent`) now also call `pushWebNotification(...)`. Push is broadcast to all renderers (`index.ts` / `headless-entry.ts` already fan out to both the WKWebView and browser clients). The renderer handler (`App.tsx` → `utils/webNotification.ts`) ignores it in the desktop webview (`isElectrobun`, native already fired) and, in a browser, shows `new Notification(...)` with `onclick` → navigate to the task. A Settings → Behavior toggle (browser-only) drives `Notification.requestPermission()` and a localStorage mute.

## Risks

- **Secure-context only.** The Web Notification API requires HTTPS or `localhost`. `dev3 remote` serves plain HTTP on `0.0.0.0`, so `http://<lan-ip>:<port>` (the open-on-phone case) has no `Notification` API. We detect this (`window.isSecureContext`) and fall back to an in-app toast; the Cloudflare tunnel and `http://localhost` work fully.
- Click-to-open uses the Notification's own `onclick` (no focus-proxy hack needed, unlike native).

## Alternatives considered

- **Reuse `cliToast` with a `desktop:true` flag** — conflates toast vs. notification intent in one event; rejected for clarity.
- **Service Worker + Push API** — would deliver even when the tab is closed, but needs a SW + push service; overkill for the "tab is open" case. Left for a future PWA effort.
