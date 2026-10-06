// What a genuine OS notification click does: bring the app window forward, and
// nothing else. No task, board or dashboard navigation, no stored target for a
// later activation to consume — see decisions/2026/10/06/notification-click-only-foregrounds.md.

export interface NotificationClickDeps {
	getWindowCount: () => number;
	openMainWindow: () => unknown;
	isAppForeground: () => boolean;
	focusFocusedWindow: () => unknown;
}

export type NotificationClickOutcome = "opened-window" | "focused-window" | "already-foreground";

export function handleNotificationClick(deps: NotificationClickDeps): NotificationClickOutcome {
	if (deps.getWindowCount() === 0) {
		void deps.openMainWindow();
		return "opened-window";
	}
	// Already in front: leave window focus and in-app focus exactly as they are.
	if (deps.isAppForeground()) return "already-foreground";
	deps.focusFocusedWindow();
	return "focused-window";
}
