# 163 — Watched-task notifications always fire in remote mode (reverses #1042's wide-viewport suppression)

## Context
PR #1042 (task seq 1211, "Hide remote status notifications") added a `WebNotificationKind`
(`status-change` | `event`) field to the `webNotification` push and made the renderer
suppress `status-change` notifications on wide remote viewports (≥768px), keeping them only on
narrow/mobile ones. The intent: on a big screen you can see the board, so status banners are noise.

That conflated "wide screen" with "actively looking at the board". A backgrounded desktop Chrome
tab is wide but exactly the case where a watched-task notification is wanted — and users got nothing.

## Decision
Removed the wide-viewport suppression entirely. Watched-task status changes now notify on every
remote viewport (wide + narrow), matching the native desktop app. Because the `kind` field existed
only to drive that gate, it is now dead and was removed in full: `WebNotificationKind`
(`src/shared/types.ts`), the `kind` field on the `webNotification` push and all its plumbing in
`src/bun/rpc-handlers/shared.ts` (`pushWebNotification`, `deliverTaskNotification`, the suppression
queue), and `shouldShowRemoteWebNotification` + `WebNotificationDetail.kind`
(`src/mainview/utils/webNotification.ts`). `App.tsx` no longer imports `useNarrowViewport` for this.

All these notifications are already gated on the per-task `watched` flag, so "always fire" means
"fire for tasks the user explicitly opted into" — the noise concern is bounded by that opt-in.

## Risks
Re-introduces the exact noise #1042 removed: if you watch a task and stare at the wide board, you
still get a browser banner on each status change. Accepted by the user (chose "always send" over a
tab-visibility gate). If it becomes noisy again, the better fix is gating on
`document.hasFocus()`/`visibilityState` (see `isTabVisibleAndFocused` in `toast.tsx`), not viewport width.

## Alternatives considered
- **Tab-visibility gate** — fire on wide only when the tab is hidden/unfocused; suppress while
  visible+focused. Reconciles both goals but adds state; user preferred the simpler "always".
- **Keep `kind`, neuter only the gate** — leaves a field with no consumer (dead code); rejected per
  the repo's no-dead-code rule.
