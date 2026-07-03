import { describe, expect, it } from "vitest";
import { computeAnchoredPosition, type RectLike } from "../popoverPosition";

const VIEWPORT = { width: 1000, height: 800 };

function rect(top: number, left: number, width: number, height: number): RectLike {
	return { top, left, width, height, right: left + width, bottom: top + height };
}

describe("computeAnchoredPosition", () => {
	it("places below the anchor by default with the given gap", () => {
		const pos = computeAnchoredPosition(rect(100, 100, 50, 20), { width: 200, height: 100 }, { viewport: VIEWPORT, gap: 6 });
		expect(pos).toEqual({ top: 126, left: 100, placement: "bottom" });
	});

	it("flips to the top when the bottom overflows", () => {
		const pos = computeAnchoredPosition(rect(750, 100, 50, 20), { width: 200, height: 100 }, { viewport: VIEWPORT, gap: 6 });
		expect(pos.placement).toBe("top");
		expect(pos.top).toBe(750 - 100 - 6);
	});

	it("keeps the preferred side when the flip would also overflow, then clamps", () => {
		// Anchor in the vertical middle of a tiny viewport: popup taller than either side.
		const vp = { width: 300, height: 120 };
		const pos = computeAnchoredPosition(rect(50, 10, 40, 20), { width: 100, height: 200 }, { viewport: vp });
		expect(pos.placement).toBe("bottom");
		expect(pos.top).toBe(8); // clamped to pad
	});

	it("centers on the cross axis when align=center", () => {
		const anchor = rect(100, 400, 40, 20);
		const pos = computeAnchoredPosition(anchor, { width: 100, height: 50 }, { viewport: VIEWPORT, align: "center" });
		expect(pos.left).toBe(400 + 20 - 50);
	});

	it("clamps the cross axis into the viewport", () => {
		const pos = computeAnchoredPosition(rect(100, 950, 40, 20), { width: 200, height: 50 }, { viewport: VIEWPORT });
		expect(pos.left).toBe(1000 - 200 - 8);
	});

	it("places to the right and flips to the left on overflow", () => {
		const pos = computeAnchoredPosition(rect(100, 900, 80, 20), { width: 150, height: 50 }, { viewport: VIEWPORT, placement: "right", gap: 6 });
		expect(pos.placement).toBe("left");
		expect(pos.left).toBe(900 - 150 - 6);
	});

	it("never returns a position outside the padded viewport", () => {
		const pos = computeAnchoredPosition(rect(-50, -50, 10, 10), { width: 300, height: 300 }, { viewport: VIEWPORT });
		expect(pos.top).toBeGreaterThanOrEqual(8);
		expect(pos.left).toBeGreaterThanOrEqual(8);
	});
});
