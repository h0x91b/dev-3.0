import { describe, expect, it, vi } from "vitest";
import { handleNotificationClick, type NotificationClickDeps } from "../notification-click";

function deps(overrides: Partial<NotificationClickDeps> = {}) {
	return {
		getWindowCount: vi.fn(() => 1),
		openMainWindow: vi.fn(),
		isAppForeground: vi.fn(() => false),
		focusFocusedWindow: vi.fn(),
		...overrides,
	};
}

describe("handleNotificationClick", () => {
	it("brings a background window to the front", () => {
		const d = deps();
		expect(handleNotificationClick(d)).toBe("focused-window");
		expect(d.focusFocusedWindow).toHaveBeenCalledTimes(1);
		expect(d.openMainWindow).not.toHaveBeenCalled();
	});

	it("leaves an already-focused app untouched", () => {
		const d = deps({ isAppForeground: vi.fn(() => true) });
		expect(handleNotificationClick(d)).toBe("already-foreground");
		expect(d.focusFocusedWindow).not.toHaveBeenCalled();
		expect(d.openMainWindow).not.toHaveBeenCalled();
	});

	it("opens a window when the app sits window-less in the dock", () => {
		const d = deps({ getWindowCount: vi.fn(() => 0) });
		expect(handleNotificationClick(d)).toBe("opened-window");
		expect(d.openMainWindow).toHaveBeenCalledTimes(1);
		expect(d.focusFocusedWindow).not.toHaveBeenCalled();
	});

	it("does the same thing on every repeated click — there is no stored target", () => {
		const d = deps();
		for (let i = 0; i < 3; i++) expect(handleNotificationClick(d)).toBe("focused-window");
		expect(d.focusFocusedWindow).toHaveBeenCalledTimes(3);
	});
});
