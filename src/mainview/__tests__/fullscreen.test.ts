import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	initAutoFullscreen,
	isFullscreenActive,
	toggleFullscreen,
	subscribeFullscreen,
	setDesktopAutoFullscreen,
	NO_AUTO_FULLSCREEN_ATTR,
	__resetFullscreenForTests,
} from "../fullscreen";

let fullscreenElement: Element | null = null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
	__resetFullscreenForTests();
	fullscreenElement = null;

	// happy-dom has no Fullscreen API — emulate the parts the module touches.
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		get: () => fullscreenElement,
	});
	requestFullscreen = vi.fn(async () => {
		fullscreenElement = document.documentElement;
		document.dispatchEvent(new Event("fullscreenchange"));
	});
	exitFullscreen = vi.fn(async () => {
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));
	});
	Object.defineProperty(document.documentElement, "requestFullscreen", {
		configurable: true,
		value: requestFullscreen,
	});
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: exitFullscreen,
	});
});

afterEach(() => {
	__resetFullscreenForTests();
});

function tap(): void {
	document.dispatchEvent(new Event("click"));
}

describe("auto fullscreen on first tap (mobile)", () => {
	it("requests fullscreen on the first tap after load", () => {
		initAutoFullscreen({ mobile: true });
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("is one-shot: later taps never re-request", () => {
		initAutoFullscreen({ mobile: true });
		tap();
		tap();
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("re-arms the next tap after leaving fullscreen", () => {
		initAutoFullscreen({ mobile: true });
		tap();
		expect(isFullscreenActive()).toBe(true);
		// User exits via system gesture — the browser just flips the state.
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));

		tap();
		expect(requestFullscreen).toHaveBeenCalledTimes(2);
	});

	it("re-arms after the explicit fullscreen toggle exits", async () => {
		initAutoFullscreen({ mobile: true });
		await toggleFullscreen();
		await toggleFullscreen();

		tap();
		expect(requestFullscreen).toHaveBeenCalledTimes(2);
	});

	it("does not arm the first-tap engage on desktop", () => {
		initAutoFullscreen({ mobile: false });
		tap();
		expect(requestFullscreen).not.toHaveBeenCalled();
	});
});

describe("auto fullscreen on first click (desktop remote)", () => {
	it("engages on the first click while the setting is on", () => {
		initAutoFullscreen({ mobile: false, desktop: true });
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("does not engage once the setting is off, and re-arms when it is back on", () => {
		initAutoFullscreen({ mobile: false, desktop: true });
		setDesktopAutoFullscreen(false);
		tap();
		expect(requestFullscreen).not.toHaveBeenCalled();

		setDesktopAutoFullscreen(true);
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("ignores a click inside the opt-out marker (the toggle that turns it off)", () => {
		initAutoFullscreen({ mobile: false, desktop: true });
		const toggle = document.createElement("button");
		const wrapper = document.createElement("div");
		wrapper.setAttribute(NO_AUTO_FULLSCREEN_ATTR, "");
		wrapper.appendChild(toggle);
		document.body.appendChild(wrapper);
		toggle.click();
		expect(requestFullscreen).not.toHaveBeenCalled();

		document.body.click();
		expect(requestFullscreen).toHaveBeenCalledOnce();
		wrapper.remove();
	});

	it("re-arms after the browser denies the request", async () => {
		requestFullscreen.mockRejectedValueOnce(new Error("denied"));
		initAutoFullscreen({ mobile: false, desktop: true });
		tap();
		await vi.waitFor(() => expect(requestFullscreen).toHaveBeenCalledOnce());
		await Promise.resolve();
		tap();
		expect(requestFullscreen).toHaveBeenCalledTimes(2);
	});

	it("stays windowed after the user leaves fullscreen, until the setting is switched back on", async () => {
		initAutoFullscreen({ mobile: false, desktop: true });
		tap();
		expect(isFullscreenActive()).toBe(true);
		await toggleFullscreen(); // View → Toggle Full Screen, or Esc
		expect(isFullscreenActive()).toBe(false);

		tap();
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();

		setDesktopAutoFullscreen(false);
		setDesktopAutoFullscreen(true);
		tap();
		expect(requestFullscreen).toHaveBeenCalledTimes(2);
	});

	it("still lets the menu toggle enter fullscreen after the user left it", async () => {
		initAutoFullscreen({ mobile: false, desktop: true });
		tap();
		await toggleFullscreen();
		await toggleFullscreen();
		expect(isFullscreenActive()).toBe(true);
	});

	it("leaves the mobile engage alone when the desktop setting is off", () => {
		initAutoFullscreen({ mobile: true, desktop: true });
		setDesktopAutoFullscreen(false);
		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});
});

describe("toggleFullscreen", () => {
	it("enters when windowed and exits when fullscreen", async () => {
		initAutoFullscreen({ mobile: false });
		await toggleFullscreen();
		expect(requestFullscreen).toHaveBeenCalledOnce();
		expect(isFullscreenActive()).toBe(true);

		await toggleFullscreen();
		expect(exitFullscreen).toHaveBeenCalledOnce();
		expect(isFullscreenActive()).toBe(false);
	});
});

describe("subscribeFullscreen", () => {
	it("notifies subscribers on fullscreen changes and supports unsubscribe", async () => {
		initAutoFullscreen({ mobile: false });
		const listener = vi.fn();
		const unsubscribe = subscribeFullscreen(listener);

		await toggleFullscreen();
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		await toggleFullscreen();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
