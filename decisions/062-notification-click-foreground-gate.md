# 062 — Notification click-to-open: foreground gate + open-mode

## Context

Watched-task notifications support click-to-open: clicking the macOS notification
focuses the task. Two bugs: (1) it always navigated to the fullscreen `task`
screen (zoom), hiding the board, regardless of how the user normally opens tasks;
(2) **any** in-app click shortly after a notification would teleport the user into
the task.

## Investigation

Electrobun's `Utils.showNotification` exposes no click callback (confirmed in
`vendor-docs/electrobun/apis/utils.md`). The feature approximates a click by
treating a window `focus` event within a TTL after the notification as the click.
This is fundamentally ambiguous: focus also fires when the user clicks back into
the app for unrelated reasons (e.g. after devtools/another window had key). The
only reliable discriminator is **whether the app was in the foreground when the
notification was posted** — if the user was already looking at the app, the banner
is informational and no navigation should be armed. Electrobun emits no native
"resign active" event, so the backend cannot know foreground state on its own.

## Decision

- Renderer reports window focus/blur to the backend via a new `setWindowForeground`
  RPC (`app-handlers.ts`); `index.ts`'s `onFocus` hook also flips it true. State
  lives in `rpc-handlers/shared.ts` (`setAppForeground`/`isAppForeground`).
- `notifyWatchedTaskStatusChange` (`shared.ts`) only arms the click-to-open slot
  when `!appForeground`. The banner is always shown.
- TTL reduced 5000ms → 3000ms (`NOTIFICATION_CLICK_TTL_MS`).
- `onOpenTaskFromNotification` (`App.tsx`) now honors `dev3-task-open-mode`
  (default `split`), matching a normal `TaskCard` click instead of forcing
  fullscreen zoom.

## Risks

- Dev-only edge case: with native devtools focused, the renderer window reports
  blur, so a notification then arms; clicking the main window navigates. Harmless
  in production (no devtools window).
- Multi-window focus/blur ordering can briefly set a wrong foreground value; worst
  case it matches today's behavior, never worse.

## Alternatives considered

- Deciding entirely in the renderer (track recent blur→focus): rejected — clicking
  the notification and clicking back into the app both produce the same renderer
  focus transition, so it cannot discriminate. The post-time foreground check can.
- Dropping the focus proxy and using only `app.reopen`: rejected — `reopen` does
  not fire reliably for notification activations, which is why focus was added.
