import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const storage = new Map<string, string>();
const localStorageMock = {
	getItem: vi.fn((key: string) => storage.get(key) ?? null),
	setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
	removeItem: vi.fn((key: string) => storage.delete(key)),
	clear: vi.fn(() => storage.clear()),
	get length() { return storage.size; },
	key: vi.fn(() => null),
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });

import {
	applyScrollSpeed,
	getScrollSpeed,
	getScrollThreshold,
	bootstrapScrollSpeed,
	DEFAULT_SCROLL_SPEED,
	MIN_SCROLL_SPEED,
	MAX_SCROLL_SPEED,
	SCROLL_SPEED_STEP,
	SCROLL_SPEED_CHANGED_EVENT,
} from "../scroll-speed";

const BASE_THRESHOLD = 50;
const KEY = "dev3-terminal-scroll-speed";

describe("scroll-speed", () => {
	beforeEach(() => {
		storage.clear();
		localStorageMock.getItem.mockClear();
		localStorageMock.setItem.mockClear();
		applyScrollSpeed(DEFAULT_SCROLL_SPEED);
		localStorageMock.setItem.mockClear();
	});

	describe("applyScrollSpeed", () => {
		it("stores the given speed in the cache", () => {
			applyScrollSpeed(2.0);
			expect(getScrollSpeed()).toBe(2.0);
		});

		it("clamps below MIN_SCROLL_SPEED", () => {
			applyScrollSpeed(0.01);
			expect(getScrollSpeed()).toBe(MIN_SCROLL_SPEED);
		});

		it("clamps above MAX_SCROLL_SPEED", () => {
			applyScrollSpeed(99);
			expect(getScrollSpeed()).toBe(MAX_SCROLL_SPEED);
		});

		it("rounds to 2 decimals to keep 0.25 steps exact", () => {
			applyScrollSpeed(1.0 + 0.1 + 0.1 + 0.05); // 1.2500000000000002 in JS
			expect(getScrollSpeed()).toBe(1.25);
		});

		it("persists to localStorage", () => {
			applyScrollSpeed(1.5);
			expect(localStorageMock.setItem).toHaveBeenCalledWith(KEY, "1.5");
		});

		it("dispatches the change event with the new speed", () => {
			const handler = vi.fn();
			window.addEventListener(SCROLL_SPEED_CHANGED_EVENT, handler);
			applyScrollSpeed(3.0);
			expect(handler).toHaveBeenCalledTimes(1);
			expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(3.0);
			window.removeEventListener(SCROLL_SPEED_CHANGED_EVENT, handler);
		});
	});

	describe("getScrollThreshold", () => {
		it("equals the baseline at speed 1.0", () => {
			applyScrollSpeed(1.0);
			expect(getScrollThreshold()).toBe(BASE_THRESHOLD);
		});

		it("halves the threshold when speed doubles (faster scroll)", () => {
			applyScrollSpeed(2.0);
			expect(getScrollThreshold()).toBe(BASE_THRESHOLD / 2);
		});

		it("raises the threshold when speed drops (slower scroll)", () => {
			applyScrollSpeed(0.5);
			expect(getScrollThreshold()).toBe(BASE_THRESHOLD / 0.5);
		});
	});

	describe("bootstrapScrollSpeed", () => {
		it("restores the speed from localStorage", () => {
			storage.set(KEY, "2.5");
			bootstrapScrollSpeed();
			expect(getScrollSpeed()).toBe(2.5);
		});

		it("defaults when no saved value", () => {
			bootstrapScrollSpeed();
			expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
		});

		it("clamps invalid saved values", () => {
			storage.set(KEY, "999");
			bootstrapScrollSpeed();
			expect(getScrollSpeed()).toBe(MAX_SCROLL_SPEED);
		});

		it("handles NaN in localStorage gracefully", () => {
			storage.set(KEY, "not-a-number");
			bootstrapScrollSpeed();
			expect(getScrollSpeed()).toBe(DEFAULT_SCROLL_SPEED);
		});

		it("does not dispatch the change event", () => {
			const handler = vi.fn();
			window.addEventListener(SCROLL_SPEED_CHANGED_EVENT, handler);
			storage.set(KEY, "1.75");
			bootstrapScrollSpeed();
			expect(handler).not.toHaveBeenCalled();
			window.removeEventListener(SCROLL_SPEED_CHANGED_EVENT, handler);
		});
	});

	describe("constants", () => {
		it("has expected default values", () => {
			expect(DEFAULT_SCROLL_SPEED).toBe(2.0);
			expect(MIN_SCROLL_SPEED).toBe(0.5);
			expect(MAX_SCROLL_SPEED).toBe(5.0);
			expect(SCROLL_SPEED_STEP).toBe(0.25);
			expect(SCROLL_SPEED_CHANGED_EVENT).toBe("terminal-scroll-speed-changed");
		});
	});
});
