import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	initAutoFullscreen,
	isFullscreenActive,
	toggleFullscreen,
	subscribeFullscreen,
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

	it("respects a manual exit: no auto re-engage on further taps", async () => {
		initAutoFullscreen({ mobile: true });
		tap();
		expect(isFullscreenActive()).toBe(true);
		// User exits via system gesture — the browser just flips the state.
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));

		tap();
		expect(requestFullscreen).toHaveBeenCalledOnce();
	});

	it("does not arm the first-tap engage on desktop", () => {
		initAutoFullscreen({ mobile: false });
		tap();
		expect(requestFullscreen).not.toHaveBeenCalled();
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
