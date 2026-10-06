# OS notification clicks only bring the app forward — no navigation

## Context

Users reported that after an OS notification, an unrelated click inside the already-focused app jumped them to a task. Three mechanisms could turn a notification into a navigation: the focus proxy (`consumeRecentWatchedNotification` — any window focus or dock reopen within 3 s of a notification counted as a click, gated by a renderer-reported foreground flag that can be stale), the native macOS delegate pushing `openTaskFromNotification` (its threadsafe `JSCallback` runs later on the Bun thread, so a click can surface after the app is already in use), and the window-less pending slot (`consumePendingNotificationNav`) that the next mounted window consumed, however much later that was.

## Decision

Removed task navigation from OS notification clicks entirely, by the user's decision, instead of repairing the routing. A genuine native click now only calls `handleNotificationClick` (`src/bun/notification-click.ts`): open a window if none exists, focus the window if the app is in the background, and do nothing if it is already in the foreground. No target is stored, so a later focus, reopen or in-app click cannot consume one. The browser Web Notification click (`webNotification.ts`) likewise only calls `window.focus()`. Delivery is unchanged — native shim, Electrobun fallback, web mirror, outbound transports — and in-app toast clicks and `dev3://` deep links still navigate.

## Risks

Users who relied on click-to-open lose it; the `tip.taskWatch` text no longer promises it. Platforms without the shim (Linux, permission denied) get no click callback at all, which the OS itself handles by activating the app (behaviour varies by desktop environment). The real click → foreground path is not covered by an automated end-to-end test — only `handleNotificationClick` is unit-tested.

## Alternatives considered

- Fix the routing (dedupe the target, timestamp the click, drop the focus proxy only) — rejected by the user: navigation from a notification is not wanted at all.
- Keep navigation only for the native delegate — rejected: the deferred callback can still land after the user started working in the app.
