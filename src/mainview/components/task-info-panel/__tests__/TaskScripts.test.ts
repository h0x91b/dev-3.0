import { describe, expect, it } from "vitest";
import { computeScriptsDropdownGeometry } from "../TaskScripts";

const MARGIN = 16;

describe("computeScriptsDropdownGeometry", () => {
	it("positions the popover just below the button", () => {
		const g = computeScriptsDropdownGeometry({ left: 100, bottom: 40 }, 1440);
		expect(g.top).toBe(46);
	});

	it("keeps full width on a wide viewport", () => {
		const g = computeScriptsDropdownGeometry({ left: 100, bottom: 40 }, 1440);
		expect(g.width).toBe(384);
		expect(g.left).toBe(100);
	});

	it("never lets the popover overflow the right edge on a narrow viewport", () => {
		// Regression: a fixed 384px width overflowed narrow (mobile/remote) windows
		// even after clamping `left` — the right side of the dropdown got cut off.
		const viewport = 375;
		const g = computeScriptsDropdownGeometry({ left: 300, bottom: 40 }, viewport);
		expect(g.left).toBeGreaterThanOrEqual(MARGIN);
		expect(g.left + g.width).toBeLessThanOrEqual(viewport - MARGIN);
	});

	it("shrinks the width to leave a gutter on both sides when the viewport is narrower than the max", () => {
		const viewport = 320;
		const g = computeScriptsDropdownGeometry({ left: 0, bottom: 40 }, viewport);
		expect(g.left).toBe(MARGIN);
		expect(g.width).toBe(viewport - MARGIN * 2);
	});

	it("clamps a button near the right edge so the popover stays on screen", () => {
		const viewport = 1000;
		const g = computeScriptsDropdownGeometry({ left: 980, bottom: 40 }, viewport);
		expect(g.left + g.width).toBeLessThanOrEqual(viewport - MARGIN);
		expect(g.width).toBe(384);
	});

	it("never returns a negative width for a degenerate viewport", () => {
		const g = computeScriptsDropdownGeometry({ left: 0, bottom: 40 }, 10);
		expect(g.width).toBeGreaterThanOrEqual(0);
	});
});
