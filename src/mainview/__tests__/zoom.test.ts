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
	getEffectiveZoom,
	adjustZoom,
	bootstrapZoom,
	DEFAULT_ZOOM,
	MOBILE_DENSE_FACTOR,
	MOBILE_ROOMY_FACTOR,
	mobileDensityForRoute,
	setMobileDensity,
	overlayScaleUp,
	MIN_ZOOM,
	MAX_ZOOM,
	ZOOM_STEP,
	ZOOM_CHANGED_EVENT,
} from "../zoom";

const DESKTOP_SCREEN_WIDTH = 1920;
const MOBILE_SCREEN_WIDTH = 390;

function setScreenWidth(width: number) {
	Object.defineProperty(window.screen, "width", { value: width, configurable: true });
}

describe("zoom", () => {
	beforeEach(() => {
		setScreenWidth(DESKTOP_SCREEN_WIDTH);
		setMobileDensity("dense"); // module state leaks between tests
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
			expect(MOBILE_DENSE_FACTOR).toBe(0.67);
			expect(MOBILE_ROOMY_FACTOR).toBe(0.84); // dense + 25%
			expect(MIN_ZOOM).toBe(0.5);
			expect(MAX_ZOOM).toBe(2.0);
			expect(ZOOM_STEP).toBe(0.1);
			expect(ZOOM_CHANGED_EVENT).toBe("zoom-changed");
		});
	});

	describe("phone density per screen", () => {
		it("keeps a task dense and everything the user browses roomy", () => {
			expect(mobileDensityForRoute({ screen: "task", projectId: "p", taskId: "t" })).toBe("dense");
			expect(mobileDensityForRoute({ screen: "project-terminal", projectId: "p" })).toBe("dense");
			expect(mobileDensityForRoute({ screen: "project", projectId: "p", taskView: true })).toBe("dense");
			expect(mobileDensityForRoute({ screen: "project", projectId: "p", activeTaskId: "t" })).toBe("dense");
			expect(mobileDensityForRoute({ screen: "project", projectId: "p" })).toBe("roomy"); // the board
			expect(mobileDensityForRoute({ screen: "dashboard" })).toBe("roomy");
			expect(mobileDensityForRoute({ screen: "settings" })).toBe("roomy");
		});

		it("re-scales the root font-size when the route switches density", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			applyZoom(DEFAULT_ZOOM);
			expect(document.documentElement.style.fontSize).toBe(`${16 * MOBILE_DENSE_FACTOR}px`);
			setMobileDensity("roomy");
			expect(getEffectiveZoom()).toBe(MOBILE_ROOMY_FACTOR);
			expect(document.documentElement.style.fontSize).toBe(`${16 * MOBILE_ROOMY_FACTOR}px`);
		});

		it("tells the terminal about a density change, so its canvas refits", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			applyZoom(DEFAULT_ZOOM);
			const handler = vi.fn();
			window.addEventListener(ZOOM_CHANGED_EVENT, handler);
			setMobileDensity("roomy");
			expect(handler).toHaveBeenCalledTimes(1);
			expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(MOBILE_ROOMY_FACTOR);
			setMobileDensity("roomy"); // same density → nothing to re-scale
			expect(handler).toHaveBeenCalledTimes(1);
			window.removeEventListener(ZOOM_CHANGED_EVENT, handler);
		});

		it("tells a browse-and-tap overlay how far to scale itself back up", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			expect(overlayScaleUp()).toBe(1.25); // dense screen: the sheet makes up the gap
			setMobileDensity("roomy");
			expect(overlayScaleUp()).toBe(1); // already roomy — no second helping
			setScreenWidth(DESKTOP_SCREEN_WIDTH);
			setMobileDensity("dense");
			expect(overlayScaleUp()).toBe(1); // desktop is never scaled at all
		});

		it("does not touch a desktop viewport, where both densities are 1", () => {
			setScreenWidth(DESKTOP_SCREEN_WIDTH);
			applyZoom(DEFAULT_ZOOM);
			const handler = vi.fn();
			window.addEventListener(ZOOM_CHANGED_EVENT, handler);
			setMobileDensity("roomy");
			expect(getEffectiveZoom()).toBe(DEFAULT_ZOOM);
			expect(document.documentElement.style.fontSize).toBe("16px");
			expect(handler).not.toHaveBeenCalled();
			window.removeEventListener(ZOOM_CHANGED_EVENT, handler);
		});
	});

	describe("phone factor", () => {
		it("scales a task screen on a phone, not just the terminal", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			applyZoom(DEFAULT_ZOOM);
			expect(getEffectiveZoom()).toBe(MOBILE_DENSE_FACTOR);
			expect(document.documentElement.style.fontSize).toBe(`${16 * MOBILE_DENSE_FACTOR}px`);
		});

		it("multiplies on top of the user's zoom without touching the saved value", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			applyZoom(1.2);
			const expected = Math.round(1.2 * MOBILE_DENSE_FACTOR * 100) / 100;
			expect(getEffectiveZoom()).toBe(expected);
			expect(document.documentElement.style.fontSize).toBe(`${16 * expected}px`);
			expect(getZoom()).toBe(1.2);
			expect(storage.get("dev3-zoom")).toBe("1.2");
		});

		it("is a no-op on a wide screen", () => {
			setScreenWidth(DESKTOP_SCREEN_WIDTH);
			applyZoom(DEFAULT_ZOOM);
			expect(getEffectiveZoom()).toBe(DEFAULT_ZOOM);
			expect(document.documentElement.style.fontSize).toBe("16px");
		});

		it("applies at bootstrap, before React mounts", () => {
			setScreenWidth(MOBILE_SCREEN_WIDTH);
			storage.set("dev3-zoom", "1");
			bootstrapZoom();
			expect(document.documentElement.style.fontSize).toBe(`${16 * MOBILE_DENSE_FACTOR}px`);
		});
	});
});
