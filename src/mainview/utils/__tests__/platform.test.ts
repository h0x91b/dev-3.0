import { afterEach, describe, expect, it } from "vitest";
import { hasAppModifier } from "../platform";

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
