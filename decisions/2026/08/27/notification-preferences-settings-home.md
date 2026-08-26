# Notification preferences have one Settings home

## Context

Notification preferences were split between Tasks & Board and System, while the one-time Web Push invitation pointed into that split. Users had to know whether a preference described task behavior or a delivery mechanism before they could find it.

## Investigation

The settings registry already provides searchable categories, stable entry anchors, and narrow-screen list-to-detail navigation. Focus Mode, the Watch default, completion sound, browser alerts, and Web Push all control whether or how task attention reaches the user; per-task Watch and shared-image viewer behavior remain object and viewer controls.

## Decision

`src/mainview/settings-registry.ts` gives those five preferences one `notifications` category, rendered by `NotificationSettingsSection.tsx`; their existing ids, anchors, and stored values stay unchanged. `pushInvite.ts` only navigates to the Web Push entry, leaving browser permission and enrollment behind explicit Settings controls.

## Risks

Global Settings gains a tenth category, but no top-level navigation destination. Browser-only delivery controls remain hidden in Electrobun, and preserving anchors avoids breaking search and deep links while callers migrate to the new category.

## Alternatives considered

Keeping transport controls in System and task-attention controls in Tasks & Board preserved the old taxonomy but kept one user job split. A top-level Notifications destination and enrollment directly from the toast were rejected as unnecessary navigation and an inappropriate durable action in transient UI.
