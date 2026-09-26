import { describe, expect, it } from "vitest";
import { drawTerminalBox } from "../terminal-box-drawing";

// Two-by-two subpixels resolve both device-aligned strokes and native quarter-pixel elbows.
function coverage(text: string, ratio: number): number[][] {
	const width = text.length * 12;
	const pixels = Array.from({ length: 27 }, () => Array<number>(width).fill(0));
	let rectangles: number[][] = [];
	let arcs: number[][] = [];
	const ctx = {
		beginPath() { rectangles = []; arcs = []; },
		rect(x: number, y: number, w: number, h: number) {
			rectangles.push([x * ratio, y * ratio, w * ratio, h * ratio]);
		},
		arc(x: number, y: number, radius: number, start: number, end: number) {
			arcs.push([x * ratio, y * ratio, radius * ratio, start, end]);
		},
		closePath() {},
		fill() {
			for (let y = 0; y < 27; y++) for (let x = 0; x < width; x++) {
				let covered = 0;
				for (const sy of [0.25, 0.75]) for (const sx of [0.25, 0.75]) {
					const px = x + sx;
					const py = y + sy;
					const rectangle = rectangles.some(([rx, ry, rw, rh]) =>
						px >= rx && px < rx + rw && py >= ry && py < ry + rh);
					let curve = false;
					if (arcs.length === 2) {
						const [ax, ay, outer, start, end] = arcs[0];
						const inner = arcs[1][2];
						const distance = (px - ax) ** 2 + (py - ay) ** 2;
						const angle = (Math.atan2(py - ay, px - ax) + 2 * Math.PI) % (2 * Math.PI);
						curve = distance >= inner ** 2 && distance <= outer ** 2 && angle >= start && angle <= end;
					}
					if (rectangle || curve) covered++;
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

	it.each([1, 1.25, 1.5, 2])("joins all rounded corners to one-pixel straight edges at DPR %s", (ratio) => {
		for (const [text, down] of [["╭─╮", true], ["╰─╯", false]] as const) {
			const pixels = coverage(text, ratio);
			expect(pixels[13].slice(11, 25)).toEqual(Array(14).fill(1));
			for (const y of down ? [20, 26] : [0, 6]) {
				expect(pixels[y]).toEqual(Array.from({ length: 36 }, (_, x) => x === 5 || x === 29 ? 1 : 0));
			}
			expect([pixels[13][5], pixels[13][29]]).toEqual([0, 0]);
		}
	});

	it.each([
		["╌", true, 2, 1], ["╍", true, 2, 3], ["╎", false, 2, 1], ["╏", false, 2, 3],
		["┄", true, 3, 1], ["┅", true, 3, 3], ["┆", false, 3, 1], ["┇", false, 3, 3],
		["┈", true, 4, 1], ["┉", true, 4, 3], ["┊", false, 4, 1], ["┋", false, 4, 3],
	] as const)("renders %s with the correct dash count and straight-line weight", (text, horizontal, count, weight) => {
		const pixels = coverage(text, 1.25);
		const line = horizontal ? pixels[13] : pixels.map(row => row[5]);
		expect(line.filter((value, i) => value > 0 && (i === 0 || line[i - 1] === 0))).toHaveLength(count);
		const segment = line.findIndex(value => value > 0);
		const crossSection = horizontal ? pixels.map(row => row[segment]) : pixels[segment];
		const centre = horizontal ? 13 : 5;
		expect(crossSection).toEqual(crossSection.map((_, i) => Math.abs(i - centre) <= (weight - 1) / 2 ? 1 : 0));
	});

	it.each([1, 1.25, 1.5, 2])("keeps double-line corners and parallel rails one pixel thick at DPR %s", (ratio) => {
		const pixels = coverage("╔═╗", ratio);
		const expected = Array.from({ length: 27 }, () => Array<number>(36).fill(0));
		for (let x = 4; x <= 30; x++) expected[12][x] = 1;
		for (let x = 6; x <= 28; x++) expected[14][x] = 1;
		for (let y = 12; y < 27; y++) expected[y][4] = expected[y][30] = 1;
		for (let y = 14; y < 27; y++) expected[y][6] = expected[y][28] = 1;
		expect(pixels).toEqual(expected);
	});

	it.each([
		["╓─╖", [13], [4, 6, 28, 30]],
		["╒═╕", [12, 14], [5, 29]],
	] as const)("joins %s without thickening its single-line arms", (text, horizontalRows, verticalColumns) => {
		const pixels = coverage(text, 1.25);
		const expected = Array.from({ length: 27 }, () => Array<number>(36).fill(0));
		const left = verticalColumns[0];
		const right = verticalColumns[verticalColumns.length - 1];
		for (const y of horizontalRows) for (let x = left; x <= right; x++) expected[y][x] = 1;
		for (let y = horizontalRows[0]; y < 27; y++) for (const x of verticalColumns) expected[y][x] = 1;
		expect(pixels).toEqual(expected);
	});

	it("keeps double-line crossings open instead of filling their central gap", () => {
		const pixels = coverage("╬", 1.25);
		const expected = Array.from({ length: 27 }, (_, y) =>
			Array.from({ length: 12 }, (_, x) =>
				((y === 12 || y === 14) && x !== 5) || ((x === 4 || x === 6) && y !== 13) ? 1 : 0));
		expect(pixels).toEqual(expected);
	});
});
