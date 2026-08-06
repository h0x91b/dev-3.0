# 160 — Keep browser notification clicks independent

## Context

Remote browser notifications used the originating task ID as `Notification.tag`.
Chrome replaces notifications with the same tag, which can leave a visible notification whose click event is owned by a different remote tab.

## Investigation

The in-app HTTP fallback and the renderer navigation callback both work in the browser.
The remaining Chrome-specific boundary is native notification replacement: Chromium documents the page callback lifetime, and same-tag replacement is known to lose the original page's click callback.

## Decision

Create each browser notification without a task-derived `tag` in `src/mainview/utils/webNotification.ts`.
This keeps the notification instance and its `onclick` handler owned by the page that displayed it, so clicking it can call `openTaskFromNotification` reliably.

## Risks

Repeated updates for one task may stack in the browser notification center instead of being coalesced by Chrome.
This is preferable to showing a notification that cannot navigate, and the user can dismiss notifications normally.

## Alternatives considered

Using a unique tag would have the same cross-tab behavior as omitting the tag while making the intent less clear.
Keeping the task ID tag preserves deduplication but retains the Chrome click-loss failure.
