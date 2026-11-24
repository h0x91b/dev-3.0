import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetKeyboardLockForTests,
	initKeyboardLock,
	isKeyboardLockSupported,
	isKeyboardLocked,
} from "../keyboard-lock";
import { __resetFullscreenForTests, initAutoFullscreen } from "../fullscreen";

/** Drive `document.fullscreenElement` and fire the event the app listens to. */
function setFullscreen(active: boolean) {
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		value: active ? document.documentElement : null,
	});
	document.dispatchEvent(new Event("fullscreenchange"));
}

const lock = vi.fn(async (_codes?: string[]) => {});
const unlock = vi.fn();

beforeEach(() => {
	lock.mockClear();
	unlock.mockClear();
	Object.defineProperty(navigator, "keyboard", { configurable: true, value: { lock, unlock } });
	__resetKeyboardLockForTests();
	__resetFullscreenForTests();
	initAutoFullscreen({ mobile: false });
	setFullscreen(false);
});

afterEach(() => {
	__resetKeyboardLockForTests();
	__resetFullscreenForTests();
	Reflect.deleteProperty(navigator, "keyboard");
});

describe("keyboard lock", () => {
	it("reports support from the presence of the API", () => {
		expect(isKeyboardLockSupported()).toBe(true);
		Reflect.deleteProperty(navigator, "keyboard");
		expect(isKeyboardLockSupported()).toBe(false);
	});

	it("locks on entering fullscreen and releases on leaving", async () => {
		initKeyboardLock();
		setFullscreen(true);
		await vi.waitFor(() => expect(isKeyboardLocked()).toBe(true));
		expect(lock).toHaveBeenCalledOnce();

		setFullscreen(false);
		await vi.waitFor(() => expect(isKeyboardLocked()).toBe(false));
		expect(unlock).toHaveBeenCalled();
	});

	it("locks Escape only while a terminal has focus — vim needs every Esc", async () => {
		const terminal = document.createElement("div");
		terminal.setAttribute("data-terminal", "true");
		const input = document.createElement("textarea");
		terminal.appendChild(input);
		document.body.appendChild(terminal);
		initKeyboardLock();
		setFullscreen(true);
		await vi.waitFor(() => expect(lock).toHaveBeenCalledOnce());
		expect(lock.mock.calls[0][0]).not.toContain("Escape");

		input.focus();
		await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
		expect(lock.mock.calls[1][0]).toContain("Escape");

		input.blur();
		await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(3));
		expect(lock.mock.calls[2][0]).not.toContain("Escape");
		terminal.remove();
	});

	it("does not lock Escape outside a terminal — a single press must still leave fullscreen", async () => {
		initKeyboardLock();
		setFullscreen(true);
		await vi.waitFor(() => expect(lock).toHaveBeenCalled());
		const codes = lock.mock.calls[0][0] ?? [];
		expect(codes).not.toContain("Escape");
		expect(codes).toContain("KeyW");
		expect(codes).toContain("Digit1");
	});

	it("stays unlocked when the browser denies the request", async () => {
		lock.mockRejectedValueOnce(new Error("denied"));
		initKeyboardLock();
		setFullscreen(true);
		await vi.waitFor(() => expect(lock).toHaveBeenCalled());
		expect(isKeyboardLocked()).toBe(false);
	});

	it("does nothing without the API", () => {
		Reflect.deleteProperty(navigator, "keyboard");
		initKeyboardLock();
		setFullscreen(true);
		expect(isKeyboardLocked()).toBe(false);
	});
});
