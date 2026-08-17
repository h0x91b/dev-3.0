import { describe, it, expect } from "vitest";
import { clampFrameToDisplay, offscreenFrameClamp, type DisplayLike } from "../window-state";

const laptop: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2, isPrimary: true };
const external: DisplayLike = { id: 2, bounds: { x: 1728, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };

describe("clampFrameToDisplay", () => {
	it("shrinks a frame that outgrew the display and pulls it inside", () => {
		const frame = { x: 200, y: 100, width: 3000, height: 2000 };
		expect(clampFrameToDisplay(frame, laptop.bounds)).toEqual({ x: 0, y: 0, width: 1728, height: 1117 });
	});

	it("leaves a frame that already fits untouched", () => {
		const frame = { x: 100, y: 50, width: 1200, height: 800 };
		expect(clampFrameToDisplay(frame, laptop.bounds)).toEqual(frame);
	});
});

describe("offscreenFrameClamp", () => {
	it("pulls back a window left hanging off the screen by a resolution drop", () => {
		// The 2560-wide external display dropped to 1280; the window kept its size.
		const shrunk: DisplayLike = { id: 2, bounds: { x: 1728, y: 0, width: 1280, height: 720 }, scaleFactor: 1 };
		const frame = { x: 1728, y: 0, width: 2400, height: 1300 };
		const result = offscreenFrameClamp(frame, [laptop, shrunk]);
		expect(result).not.toBeNull();
		expect(result!.display.id).toBe(2);
		expect(result!.frame).toEqual({ x: 1728, y: 0, width: 1280, height: 720 });
	});

	it("leaves a window spanning two displays exactly where the user put it", () => {
		const frame = { x: 1200, y: 100, width: 1400, height: 900 };
		expect(offscreenFrameClamp(frame, [laptop, external])).toBeNull();
	});

	it("ignores a hairline sliver outside the display", () => {
		const frame = { x: -1, y: 0, width: 1200, height: 800 };
		expect(offscreenFrameClamp(frame, [laptop, external])).toBeNull();
	});

	it("rescues a window stranded on a display that was unplugged", () => {
		const frame = { x: 2000, y: 200, width: 1200, height: 800 };
		const result = offscreenFrameClamp(frame, [laptop]);
		expect(result).not.toBeNull();
		expect(result!.display.id).toBe(1);
		expect(result!.frame).toEqual({ x: 528, y: 200, width: 1200, height: 800 });
	});

	it("does nothing when no display is known", () => {
		expect(offscreenFrameClamp({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull();
	});
});
