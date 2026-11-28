import { containedPictureBox, normalisedSpot } from "../VideoFrameSpots";

describe("video frame spot geometry", () => {
	it("finds the picture inside a letterboxed element, pillarboxed or not", () => {
		// 16:9 clip in a square element: bars above and below.
		expect(containedPictureBox({ left: 10, top: 20, width: 400, height: 400 }, { w: 1920, h: 1080 })).toEqual({ left: 10, top: 107.5, width: 400, height: 225 });
		// Portrait clip in a wide element: bars left and right.
		expect(containedPictureBox({ left: 0, top: 0, width: 800, height: 400 }, { w: 1080, h: 1920 })).toEqual({ left: 287.5, top: 0, width: 225, height: 400 });
		// No metadata yet: the element is the best guess.
		expect(containedPictureBox({ left: 1, top: 2, width: 3, height: 4 }, null)).toEqual({ left: 1, top: 2, width: 3, height: 4 });
	});

	it("puts a spot on the same pixel of the frame at any size", () => {
		const natural = { w: 1920, h: 1080 };
		const pixel = { x: 480, y: 270 };
		for (const element of [{ left: 0, top: 0, width: 640, height: 360 }, { left: 50, top: 0, width: 1600, height: 1600 }, { left: 0, top: 0, width: 300, height: 900 }]) {
			const picture = containedPictureBox(element, natural);
			const scale = picture.width / natural.w;
			const spot = normalisedSpot(picture, picture.left + pixel.x * scale, picture.top + pixel.y * scale);
			expect(spot).toEqual({ x: 0.25, y: 0.25 });
		}
	});

	it("ignores a click in the letterbox bars", () => {
		const picture = containedPictureBox({ left: 0, top: 0, width: 400, height: 400 }, { w: 1920, h: 1080 });
		expect(normalisedSpot(picture, 200, 50)).toBeNull();
		expect(normalisedSpot(picture, 200, 200)).toEqual({ x: 0.5, y: 0.5 });
	});
});
