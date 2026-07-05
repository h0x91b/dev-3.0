// Pending notification-click navigation, for clicks that arrive while the app
// has NO window (it lives in the dock after the last window closed).
//
// Same pull-on-mount pattern as quit-manager's pending quit dialog: the click
// handler stores the target and reopens a window; the freshly mounted renderer
// PULLS the target via the `consumePendingNotificationNav` RPC (a push would
// race the not-yet-registered `rpc:openTaskFromNotification` listener and get
// lost) and navigates to the task.

import type { NotificationClickTarget } from "./native-notifications";

let pendingNav: NotificationClickTarget | null = null;

export function markPendingNotificationNav(target: NotificationClickTarget): void {
	pendingNav = target;
}

/** Read and clear the pending target — the reopened renderer calls this on mount. */
export function consumePendingNotificationNav(): NotificationClickTarget | null {
	const target = pendingNav;
	pendingNav = null;
	return target;
}

/** Test-only: reset between cases. */
export function __resetPendingNotificationNavForTests(): void {
	pendingNav = null;
}
