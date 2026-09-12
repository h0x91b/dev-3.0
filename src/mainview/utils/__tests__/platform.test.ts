import { afterEach, describe, expect, it } from "vitest";
import { hasAppModifier, isTouchPrimary } from "../platform";

const originalNavigator = globalThis.navigator;

function setPlatform(platform: string, userAgent: string) {
	Object.defineProperty(globalThis, "navigator", {
		value: { platform, userAgent },
		writable: true,
		configurable: true,
	});
}

function keyEvent(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean }): KeyboardEvent {
	return new KeyboardEvent("keydown", { key, ...mods });
}

afterEach(() => {
	Object.defineProperty(globalThis, "navigator", {
		value: originalNavigator,
		writable: true,
		configurable: true,
	});
});

describe("hasAppModifier", () => {
	it("accepts only Cmd on macOS, so Ctrl+<key> stays with the terminal", () => {
		setPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		expect(hasAppModifier(keyEvent("o", { metaKey: true }))).toBe(true);
		expect(hasAppModifier(keyEvent("o", { ctrlKey: true }))).toBe(false);
	});

	it("accepts only Ctrl off macOS", () => {
		setPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
		expect(hasAppModifier(keyEvent("o", { ctrlKey: true }))).toBe(true);
		expect(hasAppModifier(keyEvent("o", { metaKey: true }))).toBe(false);
	});

	it("is false with no modifier on either platform", () => {
		setPlatform("MacIntel", "Mozilla/5.0 (Macintosh)");
		expect(hasAppModifier(keyEvent("o", {}))).toBe(false);
		setPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
		expect(hasAppModifier(keyEvent("o", {}))).toBe(false);
	});
});

describe("isTouchPrimary", () => {
	const originalMatchMedia = globalThis.window?.matchMedia;

	function setTouchPoints(maxTouchPoints: number) {
		Object.defineProperty(globalThis, "navigator", {
			value: { ...originalNavigator, maxTouchPoints },
			writable: true,
			configurable: true,
		});
	}

	function setCoarsePointer(coarse: boolean) {
		window.matchMedia = ((query: string) => ({
			matches: query.includes("pointer: coarse") ? coarse : false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		})) as typeof window.matchMedia;
	}

	afterEach(() => {
		if (originalMatchMedia) window.matchMedia = originalMatchMedia;
	});

	it("is true on a phone — touch points and a coarse primary pointer", () => {
		setTouchPoints(5);
		setCoarsePointer(true);
		expect(isTouchPrimary()).toBe(true);
	});

	it("is false on a touchscreen laptop, where the mouse is the primary pointer", () => {
		setTouchPoints(10);
		setCoarsePointer(false);
		expect(isTouchPrimary()).toBe(false);
	});

	it("is false with no touch points, without consulting the media query", () => {
		setTouchPoints(0);
		setCoarsePointer(true);
		expect(isTouchPrimary()).toBe(false);
	});

	it("falls back to the touch points where pointer media queries are unavailable", () => {
		setTouchPoints(5);
		(window as { matchMedia?: unknown }).matchMedia = undefined;
		expect(isTouchPrimary()).toBe(true);
	});
});
