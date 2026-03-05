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
	applyZoom,
	getZoom,
	adjustZoom,
	bootstrapZoom,
	DEFAULT_ZOOM,
	MIN_ZOOM,
	MAX_ZOOM,
	ZOOM_STEP,
	ZOOM_CHANGED_EVENT,
} from "../zoom";

describe("zoom", () => {
	beforeEach(() => {
		storage.clear();
		localStorageMock.getItem.mockClear();
		localStorageMock.setItem.mockClear();
		document.documentElement.style.fontSize = "";
		// Reset to default
		applyZoom(DEFAULT_ZOOM);
	});

	describe("applyZoom", () => {
		it("sets root font-size based on zoom level", () => {
			applyZoom(1.5);
			expect(document.documentElement.style.fontSize).toBe("24px"); // 16 * 1.5
		});

		it("clamps zoom to MIN_ZOOM", () => {
			applyZoom(0.1);
			expect(getZoom()).toBe(MIN_ZOOM);
			expect(document.documentElement.style.fontSize).toBe(`${16 * MIN_ZOOM}px`);
		});

		it("clamps zoom to MAX_ZOOM", () => {
			applyZoom(5.0);
			expect(getZoom()).toBe(MAX_ZOOM);
			expect(document.documentElement.style.fontSize).toBe(`${16 * MAX_ZOOM}px`);
		});

		it("rounds to 2 decimal places to avoid floating point drift", () => {
			applyZoom(1.0 + 0.1 + 0.1 + 0.1); // 1.3000000000000003 in JS
			expect(getZoom()).toBe(1.3);
		});

		it("persists zoom level to localStorage", () => {
			applyZoom(1.2);
			expect(localStorageMock.setItem).toHaveBeenCalledWith("dev3-zoom", "1.2");
		});

		it("dispatches zoom-changed event with new level", () => {
			const handler = vi.fn();
			window.addEventListener(ZOOM_CHANGED_EVENT, handler);
			applyZoom(1.4);
			expect(handler).toHaveBeenCalledTimes(1);
			expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(1.4);
			window.removeEventListener(ZOOM_CHANGED_EVENT, handler);
		});
	});

	describe("getZoom", () => {
		it("returns current zoom level from in-memory cache", () => {
			applyZoom(1.7);
			expect(getZoom()).toBe(1.7);
		});

		it("returns default zoom initially", () => {
			applyZoom(DEFAULT_ZOOM);
			expect(getZoom()).toBe(DEFAULT_ZOOM);
		});
	});

	describe("adjustZoom", () => {
		it("increments zoom by delta", () => {
			applyZoom(1.0);
			adjustZoom(ZOOM_STEP);
			expect(getZoom()).toBe(1.1);
		});

		it("decrements zoom by negative delta", () => {
			applyZoom(1.0);
			adjustZoom(-ZOOM_STEP);
			expect(getZoom()).toBe(0.9);
		});

		it("does not exceed MAX_ZOOM", () => {
			applyZoom(MAX_ZOOM);
			adjustZoom(ZOOM_STEP);
			expect(getZoom()).toBe(MAX_ZOOM);
		});

		it("does not go below MIN_ZOOM", () => {
			applyZoom(MIN_ZOOM);
			adjustZoom(-ZOOM_STEP);
			expect(getZoom()).toBe(MIN_ZOOM);
		});
	});

	describe("bootstrapZoom", () => {
		it("restores zoom from localStorage", () => {
			storage.set("dev3-zoom", "1.5");
			bootstrapZoom();
			expect(getZoom()).toBe(1.5);
			expect(document.documentElement.style.fontSize).toBe("24px");
		});

		it("defaults to 1.0 when no saved value", () => {
			bootstrapZoom();
			expect(getZoom()).toBe(DEFAULT_ZOOM);
			expect(document.documentElement.style.fontSize).toBe("16px");
		});

		it("clamps invalid saved values", () => {
			storage.set("dev3-zoom", "99");
			bootstrapZoom();
			expect(getZoom()).toBe(MAX_ZOOM);
		});

		it("handles NaN in localStorage gracefully", () => {
			storage.set("dev3-zoom", "not-a-number");
			bootstrapZoom();
			expect(getZoom()).toBe(DEFAULT_ZOOM); // parseFloat("not-a-number") = NaN → falls back
		});

		it("does not dispatch zoom-changed event", () => {
			const handler = vi.fn();
			window.addEventListener(ZOOM_CHANGED_EVENT, handler);
			storage.set("dev3-zoom", "1.3");
			bootstrapZoom();
			expect(handler).not.toHaveBeenCalled();
			window.removeEventListener(ZOOM_CHANGED_EVENT, handler);
		});
	});

	describe("constants", () => {
		it("has expected default values", () => {
			expect(DEFAULT_ZOOM).toBe(1.0);
			expect(MIN_ZOOM).toBe(0.5);
			expect(MAX_ZOOM).toBe(2.0);
			expect(ZOOM_STEP).toBe(0.1);
			expect(ZOOM_CHANGED_EVENT).toBe("zoom-changed");
		});
	});
});
