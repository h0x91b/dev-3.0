import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useViewportClamp, type ViewportPosition } from "../useViewportClamp";

function refTo(width: number, height: number) {
	const el = document.createElement("div");
	el.getBoundingClientRect = () =>
		({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	return { current: el };
}

function clamp(ref: { current: HTMLElement | null }, position: ViewportPosition) {
	return renderHook(() => useViewportClamp(ref, position)).result.current;
}

describe("useViewportClamp", () => {
	beforeEach(() => {
		window.innerWidth = 390; // a phone over dev3 remote
		window.innerHeight = 800;
	});

	it("stays hidden until it has been measured", () => {
		const { position, visible } = clamp({ current: null }, { top: 10, left: 10 });
		expect(visible).toBe(false);
		expect(position).toEqual({ top: 10, left: 10 });
	});

	it("pulls an overlay back inside the right edge", () => {
		const { position, visible } = clamp(refTo(200, 100), { top: 40, left: 300 });
		expect(visible).toBe(true);
		expect(position.left).toBe(390 - 200 - 8);
	});

	it("pulls an overlay back above the bottom edge", () => {
		const { position } = clamp(refTo(120, 300), { top: 700, left: 20 });
		expect(position.top).toBe(800 - 300 - 8);
	});

	it("never pushes past the leading or top edge, even when it does not fit", () => {
		const { position } = clamp(refTo(600, 900), { top: 500, left: 500 });
		expect(position).toEqual({ top: 8, left: 8 });
	});

	it("leaves a position that already fits alone", () => {
		const { position } = clamp(refTo(100, 100), { top: 50, left: 50 });
		expect(position).toEqual({ top: 50, left: 50 });
	});
});
