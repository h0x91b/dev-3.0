import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastMock = vi.hoisted(() => ({
	error: vi.fn(),
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("../../toast", () => ({ toast: toastMock }));

import {
	browserNotificationsEnabled,
	setBrowserNotificationsEnabled,
	webNotificationsSupported,
	canShowWebNotification,
	showWebNotificationOrToast,
	BROWSER_NOTIFICATIONS_PREF_KEY,
	type WebNotificationDetail,
} from "../webNotification";

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static requestPermission = vi.fn();
	static instances: FakeNotification[] = [];
	onclick: (() => void) | null = null;
	close = vi.fn();
	constructor(
		public title: string,
		public options?: NotificationOptions,
	) {
		FakeNotification.instances.push(this);
	}
}

function setSecureContext(value: boolean) {
	Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

function installNotification(permission: NotificationPermission = "granted") {
	FakeNotification.permission = permission;
	FakeNotification.instances = [];
	(window as unknown as { Notification: unknown }).Notification = FakeNotification;
}

function uninstallNotification() {
	delete (window as unknown as { Notification?: unknown }).Notification;
}

const baseDetail: WebNotificationDetail = {
	taskId: "task-1",
	projectId: "proj-1",
	title: "#42 Fix bug",
	body: "In Progress → Review",
	level: "info",
	taskSeq: 42,
	taskTitle: "Fix bug",
	projectName: "MyProject",
};

beforeEach(() => {
	localStorage.clear();
	toastMock.error.mockClear();
	toastMock.success.mockClear();
	toastMock.info.mockClear();
	toastMock.warning.mockClear();
	setSecureContext(true);
	installNotification("granted");
});

afterEach(() => {
	uninstallNotification();
});

describe("browserNotificationsEnabled / setBrowserNotificationsEnabled", () => {
	it("defaults to enabled when no preference is stored", () => {
		expect(browserNotificationsEnabled()).toBe(true);
	});

	it("muting stores 'off' and disables", () => {
		setBrowserNotificationsEnabled(false);
		expect(localStorage.getItem(BROWSER_NOTIFICATIONS_PREF_KEY)).toBe("off");
		expect(browserNotificationsEnabled()).toBe(false);
	});

	it("re-enabling clears the stored preference", () => {
		setBrowserNotificationsEnabled(false);
		setBrowserNotificationsEnabled(true);
		expect(localStorage.getItem(BROWSER_NOTIFICATIONS_PREF_KEY)).toBeNull();
		expect(browserNotificationsEnabled()).toBe(true);
	});
});

describe("webNotificationsSupported", () => {
	it("is true in a secure context with the Notification API", () => {
		expect(webNotificationsSupported()).toBe(true);
	});

	it("is false in an insecure context (plain http LAN)", () => {
		setSecureContext(false);
		expect(webNotificationsSupported()).toBe(false);
	});

	it("is false when the Notification API is absent", () => {
		uninstallNotification();
		expect(webNotificationsSupported()).toBe(false);
	});
});

describe("canShowWebNotification", () => {
	it("is true only when supported, granted and not muted", () => {
		expect(canShowWebNotification()).toBe(true);
	});

	it("is false when permission is not granted", () => {
		installNotification("default");
		expect(canShowWebNotification()).toBe(false);
	});

	it("is false when the user muted notifications", () => {
		setBrowserNotificationsEnabled(false);
		expect(canShowWebNotification()).toBe(false);
	});
});

describe("showWebNotificationOrToast", () => {
	it("creates a Web Notification when allowed, wiring click-to-open", () => {
		const onOpen = vi.fn();
		showWebNotificationOrToast(baseDetail, onOpen);

		expect(FakeNotification.instances).toHaveLength(1);
		const n = FakeNotification.instances[0];
		expect(n.title).toBe("#42 Fix bug");
		expect(n.options?.body).toBe("In Progress → Review");
		expect(toastMock.info).not.toHaveBeenCalled();

		n.onclick?.();
		expect(onOpen).toHaveBeenCalledWith("task-1", "proj-1");
		expect(n.close).toHaveBeenCalled();
	});

	it("falls back to a toast in an insecure context", () => {
		setSecureContext(false);
		const onOpen = vi.fn();
		showWebNotificationOrToast(baseDetail, onOpen);

		expect(FakeNotification.instances).toHaveLength(0);
		expect(toastMock.info).toHaveBeenCalledTimes(1);
		const [message, opts] = toastMock.info.mock.calls[0];
		expect(message).toBe("In Progress → Review");
		expect(opts.context).toBe("#42 · MyProject · Fix bug");
		opts.onClick();
		expect(onOpen).toHaveBeenCalledWith("task-1", "proj-1");
	});

	it("falls back to a toast when permission is not granted", () => {
		installNotification("denied");
		showWebNotificationOrToast(baseDetail, null);
		expect(FakeNotification.instances).toHaveLength(0);
		expect(toastMock.info).toHaveBeenCalledTimes(1);
	});

	it("uses the requested toast level for the fallback", () => {
		setSecureContext(false);
		showWebNotificationOrToast({ ...baseDetail, level: "error" }, null);
		expect(toastMock.error).toHaveBeenCalledTimes(1);
		expect(toastMock.info).not.toHaveBeenCalled();
	});
});
