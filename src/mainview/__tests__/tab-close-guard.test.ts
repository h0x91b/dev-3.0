import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetTabCloseGuardForTests,
	initTabCloseGuard,
	isTabCloseGuardActive,
	reloadPage,
	setTabCloseGuardEnabled,
} from "../tab-close-guard";

/** Fire `beforeunload` the way a browser does and report whether the page asked to stay. */
function closeTab(): boolean {
	const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

const reload = vi.fn();

beforeEach(() => {
	__resetTabCloseGuardForTests();
	reload.mockClear();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
});

afterEach(() => {
	__resetTabCloseGuardForTests();
	Reflect.deleteProperty(window, "__electrobunWebviewId");
});

describe("tab close guard", () => {
	it("asks before the tab closes in browser remote mode", () => {
		initTabCloseGuard();
		expect(isTabCloseGuardActive()).toBe(true);
		expect(closeTab()).toBe(true);
	});

	it("is never installed in the desktop shell, where it would block quit and reload", () => {
		(window as Window & { __electrobunWebviewId?: number }).__electrobunWebviewId = 1;
		initTabCloseGuard();
		expect(isTabCloseGuardActive()).toBe(false);
		expect(closeTab()).toBe(false);
	});

	it("stays quiet when the setting is off, and asks again once it is back on", () => {
		initTabCloseGuard();
		setTabCloseGuardEnabled(false);
		expect(closeTab()).toBe(false);
		setTabCloseGuardEnabled(true);
		expect(closeTab()).toBe(true);
	});

	it("lets the app's own reload through without a prompt", () => {
		initTabCloseGuard();
		reloadPage();
		expect(reload).toHaveBeenCalledOnce();
		expect(closeTab()).toBe(false);
	});
});
