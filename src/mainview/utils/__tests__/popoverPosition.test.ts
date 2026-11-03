import { describe, expect, it } from "vitest";
import { computeAnchoredPosition, computeBesidePosition, type RectLike } from "../popoverPosition";

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

function overlaps(a: RectLike, top: number, left: number, size: { width: number; height: number }): boolean {
	return left < a.right && left + size.width > a.left && top < a.bottom && top + size.height > a.top;
}

describe("computeBesidePosition", () => {
	it("opens to the right of the anchor, top-aligned", () => {
		const anchor = rect(100, 100, 50, 20);
		const pos = computeBesidePosition(anchor, { width: 300, height: 200 }, { viewport: VIEWPORT });
		expect(pos).toEqual({ top: 100, left: 156, maxHeight: 784, placement: "right" });
	});

	it("flips left only when the right side has no room", () => {
		const anchor = rect(100, 800, 50, 20);
		const pos = computeBesidePosition(anchor, { width: 300, height: 200 }, { viewport: VIEWPORT });
		expect(pos.placement).toBe("left");
		expect(pos.left).toBe(800 - 6 - 300);
	});

	it("never covers the anchor with a popover taller than the viewport", () => {
		// The reported bug: ~45 checks made the card taller than the window, and the
		// old bottom placement was clamped up over its own badge.
		const anchor = rect(700, 100, 60, 20);
		const size = { width: 352, height: 1400 };
		const pos = computeBesidePosition(anchor, size, { viewport: VIEWPORT });
		expect(pos.placement).toBe("right");
		expect(pos.maxHeight).toBe(784);
		expect(pos.top).toBe(8);
		expect(overlaps(anchor, pos.top, pos.left, { width: size.width, height: pos.maxHeight })).toBe(false);
	});

	it("slides up to stay on screen when the anchor sits near the bottom", () => {
		const pos = computeBesidePosition(rect(750, 100, 50, 20), { width: 300, height: 300 }, { viewport: VIEWPORT });
		expect(pos.top).toBe(800 - 8 - 300);
	});

	it("falls back below or above, capped to that gap, when neither side fits", () => {
		const vp = { width: 400, height: 800 };
		const low = rect(600, 150, 100, 20);
		const above = computeBesidePosition(low, { width: 352, height: 1000 }, { viewport: vp });
		expect(above.placement).toBe("top");
		expect(above.maxHeight).toBe(600 - 6 - 8);
		expect(overlaps(low, above.top, above.left, { width: 352, height: above.maxHeight })).toBe(false);

		const high = rect(100, 150, 100, 20);
		const below = computeBesidePosition(high, { width: 352, height: 1000 }, { viewport: vp });
		expect(below.placement).toBe("bottom");
		expect(below.top).toBe(126);
		expect(below.maxHeight).toBe(800 - 8 - 126);
	});
});
