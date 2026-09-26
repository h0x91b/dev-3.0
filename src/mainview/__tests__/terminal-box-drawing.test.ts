import { describe, expect, it } from "vitest";
import { drawTerminalBox } from "../terminal-box-drawing";

// Two-by-two subpixels resolve both device-aligned strokes and native quarter-pixel elbows.
function coverage(text: string, ratio: number): number[][] {
	const width = text.length * 12;
	const pixels = Array.from({ length: 27 }, () => Array<number>(width).fill(0));
	let rectangles: number[][] = [];
	const ctx = {
		beginPath() { rectangles = []; },
		rect(x: number, y: number, w: number, h: number) {
			rectangles.push([x * ratio, y * ratio, w * ratio, h * ratio]);
		},
		fill() {
			for (let y = 0; y < 27; y++) for (let x = 0; x < width; x++) {
				let covered = 0;
				for (const sy of [0.25, 0.75]) for (const sx of [0.25, 0.75]) {
					if (rectangles.some(([rx, ry, rw, rh]) =>
						x + sx >= rx && x + sx < rx + rw && y + sy >= ry && y + sy < ry + rh)) covered++;
				}
				pixels[y][x] += covered / 4;
			}
		},
	} as unknown as CanvasRenderingContext2D;
	for (let col = 0; col < text.length; col++) {
		drawTerminalBox(ctx, text.charCodeAt(col), col * 12 / ratio, 0, 12 / ratio, 27 / ratio, ratio, 1);
	}
	return pixels;
}

describe("native box strokes", () => {
	it.each([1, 1.25, 1.5, 2])("joins a light frame without resampling at DPR %s", (ratio) => {
		const pixels = coverage("┌─┐", ratio);
		const expected = Array.from({ length: 27 }, () => Array<number>(36).fill(0));
		for (let x = 6; x < 29; x++) expected[13][x] = 1;
		expected[13][5] = expected[13][29] = 0.75;
		for (let y = 14; y < 27; y++) expected[y][5] = expected[y][29] = 1;
		expect(pixels).toEqual(expected);
	});

	it("keeps heavy lines three physical pixels wide, including their corner joints", () => {
		const pixels = coverage("┏━┓", 1.25);
		const expected = Array.from({ length: 27 }, () => Array<number>(36).fill(0));
		for (let y = 12; y <= 14; y++) for (let x = 4; x <= 30; x++) expected[y][x] = 1;
		for (let y = 15; y < 27; y++) {
			for (const x of [4, 5, 6, 28, 29, 30]) expected[y][x] = 1;
		}
		expect(pixels).toEqual(expected);
	});

	it("preserves different horizontal and vertical weights at a mixed crossing", () => {
		const pixels = coverage("┿", 1.25);
		const expected = Array.from({ length: 27 }, (_, y) =>
			Array.from({ length: 12 }, (_, x) => (x === 5 || (y >= 12 && y <= 14)) ? 1 : 0));
		expect(pixels).toEqual(expected);
	});
});
