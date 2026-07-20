import { describe, it, expect } from "vitest";
import { clampTransform, zoomAt, MIN_SCALE, MAX_SCALE, IDENTITY } from "../usePinchZoom";

describe("clampTransform", () => {
	it("snaps back to a centred identity at or below minimum scale", () => {
		expect(clampTransform({ scale: 0.4, x: 50, y: 50 }, 200, 100)).toEqual({ scale: MIN_SCALE, x: 0, y: 0 });
		expect(clampTransform({ scale: 1, x: 30, y: -20 }, 200, 100)).toEqual({ scale: 1, x: 0, y: 0 });
	});

	it("caps scale at MAX_SCALE", () => {
		expect(clampTransform({ scale: 99, x: 0, y: 0 }, 200, 100).scale).toBe(MAX_SCALE);
	});

	it("bounds translation so scaled content stays within the element edges", () => {
		// At scale 2 on a 200x100 box the reachable offset is (scale-1)*size/2.
		const t = clampTransform({ scale: 2, x: 999, y: -999 }, 200, 100);
		expect(t.x).toBe(100); // (2-1)*200/2
		expect(t.y).toBe(-50); // (2-1)*100/2
	});

	it("passes through translation already inside the bounds", () => {
		const t = clampTransform({ scale: 3, x: 40, y: 20 }, 200, 100);
		expect(t).toEqual({ scale: 3, x: 40, y: 20 });
	});
});

describe("zoomAt", () => {
	it("is a no-op transform when target scale equals current scale", () => {
		expect(zoomAt(IDENTITY, 30, 10, 1)).toEqual({ scale: 1, x: 0, y: 0 });
	});

	it("keeps the anchored point fixed while zooming in from identity", () => {
		const px = 40, py = -20, target = 2;
		const next = zoomAt(IDENTITY, px, py, target);
		expect(next.scale).toBe(target);
		// The content coordinate under the anchor must map back to the same screen point.
		const content = { x: (px - next.x) / next.scale, y: (py - next.y) / next.scale };
		expect(content.x * target + next.x).toBeCloseTo(px);
		expect(content.y * target + next.y).toBeCloseTo(py);
	});

	it("zooming toward the centre point leaves translation at zero", () => {
		expect(zoomAt(IDENTITY, 0, 0, 3)).toEqual({ scale: 3, x: 0, y: 0 });
	});
});
