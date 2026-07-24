import { toast } from "../toast";

/**
 * Browser Web Notifications for remote/headless mode.
 *
 * When the UI is opened in a browser via `dev3 remote`, the native
 * `Utils.showNotification` is a no-op, so notifications that would appear in the
 * desktop app (`dev3 notify --desktop`, watched-task banners) are pushed to the
 * browser as a `webNotification` event and surfaced here.
 *
 * Hard constraint: the Web Notification API requires a **secure context**
 * (HTTPS or `localhost`). `dev3 remote` serves plain HTTP on the LAN, so a phone
 * opening `http://<lan-ip>:<port>` has no `Notification` API at all — that path
 * falls back to an in-app toast. The Cloudflare tunnel (`https://…`) and
 * `http://localhost` both qualify as secure contexts and get real notifications.
 */

/** localStorage key for the user's opt-out. Absent/"on" = enabled, "off" = muted. */
export const BROWSER_NOTIFICATIONS_PREF_KEY = "dev3-browser-notifications";

/** Whether the user has muted browser notifications (default: enabled). */
export function browserNotificationsEnabled(): boolean {
	try {
		return localStorage.getItem(BROWSER_NOTIFICATIONS_PREF_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setBrowserNotificationsEnabled(enabled: boolean): void {
	try {
		if (enabled) localStorage.removeItem(BROWSER_NOTIFICATIONS_PREF_KEY);
		else localStorage.setItem(BROWSER_NOTIFICATIONS_PREF_KEY, "off");
	} catch {
		/* localStorage unavailable (private mode) — ignore */
	}
}

/** Whether the Notification API exists in a usable (secure) context here. */
export function webNotificationsSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		window.isSecureContext === true &&
		"Notification" in window
	);
}

/** Whether a Web Notification can actually be shown right now. */
export function canShowWebNotification(): boolean {
	return (
		webNotificationsSupported() &&
		Notification.permission === "granted" &&
		browserNotificationsEnabled()
	);
}

export interface WebNotificationDetail {
	taskId: string;
	projectId: string;
	title: string;
	body: string;
	level: "info" | "success" | "error";
	taskSeq?: number;
	taskTitle?: string;
	projectName?: string;
}

interface PendingWebNotification {
	detail: WebNotificationDetail;
	onOpenTask: ((taskId: string, projectId: string) => void) | null;
}

let suppressed = false;
const pendingNotifications: PendingWebNotification[] = [];

/** Suppress browser notifications while terminal immersive fullscreen is active. */
export function setWebNotificationsSuppressed(value: boolean): void {
	if (suppressed === value) return;
	suppressed = value;
	if (suppressed) return;

	const pending = pendingNotifications.splice(0, pendingNotifications.length);
	pending.forEach(({ detail, onOpenTask }) => showWebNotificationOrToast(detail, onOpenTask));
}

/**
 * Show a browser Web Notification for the payload, or fall back to an in-app
 * toast when the Notification API is unavailable (insecure LAN context), not
 * granted, or muted by the user. `onOpenTask` runs when the user clicks either.
 */
export function showWebNotificationOrToast(
	detail: WebNotificationDetail,
	onOpenTask: ((taskId: string, projectId: string) => void) | null,
): void {
	if (suppressed) {
		pendingNotifications.push({ detail, onOpenTask });
		return;
	}

	const openTask =
		detail.taskId && detail.projectId && onOpenTask
			? () => onOpenTask(detail.taskId, detail.projectId)
			: undefined;

	if (canShowWebNotification()) {
		try {
			// Chrome can replace same-tag notifications from another tab without
			// delivering the click to the page that created the visible notification.
			const n = new Notification(detail.title, {
				body: detail.body,
			});
			n.onclick = () => {
				try {
					window.focus();
				} catch {
					/* focus may be blocked — best effort */
				}
				openTask?.();
				n.close();
			};
			return;
		} catch {
			// Some browsers throw on direct `new Notification(...)` (require a
			// service worker). Fall through to the toast instead of crashing.
		}
	}

	const context =
		[
			detail.taskSeq !== undefined ? `#${detail.taskSeq}` : null,
			detail.projectName,
			detail.taskTitle,
		]
			.filter(Boolean)
			.join(" · ") || undefined;
	toast[detail.level](detail.body, {
		onClick: openTask,
		context,
		taskId: detail.taskId || undefined,
	});
}
