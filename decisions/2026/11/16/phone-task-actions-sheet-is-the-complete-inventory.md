# The phone task actions sheet is the complete action inventory

## Context

An audit of the desktop task actions against the phone surfaces (2026-11-16, with the maintainer's
user) found three gaps. Hibernate and terminal fullscreen had no touch path: Hibernate lived in the
session bar and the context menu, and fullscreen was inspector chrome plus F11 / ⇧⌘F. The sheet also
offered a Hide icon on `+ Agent` / `Find bugs` with no way back, because `PanelRestoreControl` is desktop-only.

## Decision

`TaskInfoPanel.tsx` (narrow branch) adds two rows to the actions BottomSheet: **Full screen** first
(`toggleTerminalFullscreen` → `toggleTerminalImmersive`) and **Hibernate** last in the action group
(the desktop `handleHibernate`, behind the same `canHibernate` gate). The sheet has no hiding at all.
`HideRowButton` is deleted. Narrow rows ignore personal hiding, because nothing on the phone can
restore it, but they honour Simplified Mode (`useIsSimplifyViewApplied`), which Settings can turn off
from the phone. `TaskGitActionsSheet` calls `refreshStatusQuietly` on mount. That is a forced remote
fetch, the same as the Refresh button, minus the forced merge re-prompt and the error toast.

The card's long-press stays the native drag, so the phone reaches "Move to" by tapping the card's
status rail. The task context menu opens on long-press only on the Active Tasks row.

## Risks

- A control someone hid on desktop shows up again in the phone sheet. That is deliberate, but it can
  look like the setting was lost.
- Every time the git sheet opens it runs a `git fetch`. The backend dedups concurrent calls.

## Alternatives considered

- **Long-press on the card opens the context menu.** Rejected: it would take over the drag gesture.
- **A restore row in the sheet.** Rejected: hiding on a phone saves no space in a scrolling sheet.
- **A per-user "buttons shown on mobile" setting.** Rejected: bible §12 forbids a mobile-mode setting.
- **Dev-server start/restart, run-script and git Refresh rows.** Dropped: they act on the machine the
  user is not sitting at, and opening the sheet now refreshes git on its own.
