import { describe, it, expect } from "vitest";
import { crc32, inflateSync } from "node:zlib";
import { clipboardImageToPng } from "../clipboard-image";

/**
 * A DIB exactly as Windows puts one on the clipboard: BITMAPINFOHEADER, then
 * 4-byte-aligned BGR(A) rows, bottom-up unless the height is negative.
 */
function buildDib(opts: {
	width: number;
	height: number; // negative = top-down
	bitCount: 24 | 32 | 8;
	rows: number[][]; // file order, raw bytes per row (before padding)
	headerSize?: number;
	alphaMask?: number;
	truncate?: number; // drop this many bytes off the end
}): Uint8Array {
	const headerSize = opts.headerSize ?? 40;
	const bytesPerPixel = opts.bitCount / 8;
	const stride = (opts.width * bytesPerPixel + 3) & ~3;
	const rowCount = Math.abs(opts.height);
	// A <=8-bit DIB carries a full colour table between header and pixels; include
	// it so such a DIB is refused for its bit depth, not for being too short.
	const paletteBytes = opts.bitCount <= 8 ? 256 * 4 : 0;
	const buf = new Uint8Array(headerSize + paletteBytes + stride * rowCount);
	const view = new DataView(buf.buffer);
	view.setUint32(0, headerSize, true);
	view.setInt32(4, opts.width, true);
	view.setInt32(8, opts.height, true);
	view.setUint16(12, 1, true); // planes
	view.setUint16(14, opts.bitCount, true);
	view.setUint32(16, 0, true); // BI_RGB
	if (opts.alphaMask !== undefined) view.setUint32(52, opts.alphaMask, true);
	opts.rows.forEach((row, i) => buf.set(row, headerSize + paletteBytes + i * stride));
	return opts.truncate ? buf.subarray(0, buf.length - opts.truncate) : buf;
}

/** Minimal PNG reader — enough to assert dimensions and actual pixels. */
function decodePng(png: Uint8Array): { width: number; height: number; colorType: number; pixels: number[][] } {
	const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	expect(
		Array.from(png.subarray(0, 8)),
		"cause: output is not a PNG file. fix: encodePng must emit the 8-byte PNG signature first",
	).toEqual(magic);

	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let at = 8;
	let width = 0;
	let height = 0;
	let colorType = 0;
	const idat: Uint8Array[] = [];
	while (at < png.length) {
		const len = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		const data = png.subarray(at + 8, at + 8 + len);
		if (type === "IHDR") {
			const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
			width = d.getUint32(0);
			height = d.getUint32(4);
			expect(data[8], "cause: PNG bit depth is not 8. fix: write 8 into IHDR byte 8").toBe(8);
			colorType = data[9]!;
		}
		if (type === "IDAT") idat.push(data);
		// zlib's own CRC32, not our hand-rolled table — a writer and a checker that
		// share one implementation would agree on a wrong value.
		expect(
			view.getUint32(at + 8 + len) >>> 0,
			`cause: the ${type} chunk CRC does not match zlib's crc32, so strict decoders will reject the PNG. fix: CRC32 must cover type+data and be finalised with ^0xffffffff`,
		).toBe(crc32(Buffer.from(png.subarray(at + 4, at + 8 + len))) >>> 0);
		at += 12 + len;
	}
	const merged = Buffer.concat(idat.map((c) => Buffer.from(c)));
	const raw = new Uint8Array(inflateSync(merged));
	const pixels: number[][] = [];
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 4);
		expect(
			raw[rowStart],
			"cause: scanline filter byte is not 0 (None). fix: prefix every scanline with a 0 filter byte",
		).toBe(0);
		for (let x = 0; x < width; x++) {
			const p = rowStart + 1 + x * 4;
			pixels.push([raw[p]!, raw[p + 1]!, raw[p + 2]!, raw[p + 3]!]);
		}
	}
	return { width, height, colorType, pixels };
}

const RED = [0x00, 0x00, 0xff]; // BGR
const GREEN = [0x00, 0xff, 0x00];
const BLUE = [0xff, 0x00, 0x00];
const WHITE = [0xff, 0xff, 0xff];

describe("clipboardImageToPng", () => {
	it("passes real PNG bytes through untouched (the macOS path)", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const result = clipboardImageToPng(png);
		expect(result.ok, "cause: PNG input rejected. fix: detect the PNG signature and pass the bytes through").toBe(true);
		if (!result.ok) return;
		expect(
			result.png,
			"cause: PNG input was re-encoded instead of passed through. fix: return the same buffer for PNG input",
		).toBe(png);
	});

	it("converts a bottom-up 24-bit DIB, un-flipping the rows", () => {
		// File order is bottom row first, so the image's TOP-LEFT pixel is red.
		const dib = buildDib({
			width: 2,
			height: 2,
			bitCount: 24,
			rows: [[...BLUE, ...WHITE], [...RED, ...GREEN]],
		});
		const result = clipboardImageToPng(dib);
		expect(result.ok, "cause: a plain 24-bit CF_DIB was refused. fix: accept biSize=40 / biBitCount=24 in dibToPng").toBe(true);
		if (!result.ok) return;
		const { width, height, colorType, pixels } = decodePng(result.png);
		expect(width, "cause: wrong PNG width. fix: copy biWidth from DIB header offset 4").toBe(2);
		expect(height, "cause: wrong PNG height. fix: use abs(biHeight) from DIB header offset 8").toBe(2);
		expect(colorType, "cause: PNG color type is not 6 (RGBA). fix: write 6 into IHDR byte 9").toBe(6);
		expect(
			pixels,
			"cause: bottom-up DIB rows were not flipped, or BGR was not swapped to RGB. fix: read source row (height-1-y) and emit R=byte[2], G=byte[1], B=byte[0]",
		).toEqual([
			[255, 0, 0, 255],
			[0, 255, 0, 255],
			[0, 0, 255, 255],
			[255, 255, 255, 255],
		]);
	});

	it("keeps row order for a top-down DIB (negative biHeight)", () => {
		const dib = buildDib({
			width: 2,
			height: -2,
			bitCount: 24,
			rows: [[...RED, ...GREEN], [...BLUE, ...WHITE]],
		});
		const result = clipboardImageToPng(dib);
		expect(result.ok, "cause: top-down DIB refused. fix: treat a negative biHeight as top-down, not invalid").toBe(true);
		if (!result.ok) return;
		expect(
			decodePng(result.png).pixels[0],
			"cause: a top-down DIB was flipped anyway, so the image is upside down. fix: when biHeight < 0 read source row y directly",
		).toEqual([255, 0, 0, 255]);
	});

	it("forces alpha opaque for 32-bit BI_RGB, where the 4th byte is undefined", () => {
		// Windows screenshots are commonly 32-bit with a zero 4th byte. Trusting it
		// yields a fully transparent PNG that looks like nothing was pasted.
		const dib = buildDib({
			width: 1,
			height: 1,
			bitCount: 32,
			rows: [[...RED, 0x00]],
		});
		const result = clipboardImageToPng(dib);
		expect(result.ok, "cause: 32-bit DIB refused. fix: accept biBitCount=32 in dibToPng").toBe(true);
		if (!result.ok) return;
		expect(
			decodePng(result.png).pixels[0],
			"cause: the undefined 4th byte of 32-bit BI_RGB was used as alpha, producing a transparent image. fix: force alpha 255 unless a V4/V5 header declares a non-zero alpha mask",
		).toEqual([255, 0, 0, 255]);
	});

	it("honours a declared alpha mask on a V5 header", () => {
		const dib = buildDib({
			width: 1,
			height: 1,
			bitCount: 32,
			headerSize: 124,
			alphaMask: 0xff000000,
			rows: [[...RED, 0x80]],
		});
		const result = clipboardImageToPng(dib);
		expect(result.ok, "cause: BITMAPV5HEADER refused. fix: allow biSize 108 and 124 in dibToPng").toBe(true);
		if (!result.ok) return;
		expect(
			decodePng(result.png).pixels[0]?.[3],
			"cause: a declared alpha mask was ignored. fix: read the alpha mask at header offset 52 when biSize >= 108 and use the source alpha byte",
		).toBe(0x80);
	});

	it("strips the 14-byte BITMAPFILEHEADER of a whole BMP file", () => {
		const dib = buildDib({ width: 1, height: 1, bitCount: 24, rows: [[...GREEN]] });
		const bmp = new Uint8Array(14 + dib.length);
		bmp[0] = 0x42; // 'B'
		bmp[1] = 0x4d; // 'M'
		bmp.set(dib, 14);
		const result = clipboardImageToPng(bmp);
		expect(result.ok, "cause: a full BMP file was refused. fix: detect the 'BM' magic and skip 14 bytes").toBe(true);
		if (!result.ok) return;
		expect(
			decodePng(result.png).pixels[0],
			"cause: the BITMAPFILEHEADER was parsed as a DIB header, so pixels are garbage. fix: subarray(14) before dibToPng",
		).toEqual([0, 255, 0, 255]);
	});

	it("reports empty clipboard bytes instead of writing a zero-byte file", () => {
		const result = clipboardImageToPng(new Uint8Array(0));
		expect(result.ok, "cause: empty input accepted. fix: return not-ok for a zero-length buffer").toBe(false);
		if (result.ok) return;
		expect(
			result.reason,
			'cause: empty input is not distinguishable from an unsupported format. fix: return reason "empty" for zero-length input',
		).toBe("empty");
	});

	it("refuses a palette DIB rather than emitting garbage pixels", () => {
		const dib = buildDib({ width: 2, height: 1, bitCount: 8, rows: [[0, 1]] });
		const result = clipboardImageToPng(dib);
		expect(
			result.ok,
			"cause: an 8-bit palette DIB was converted as if it were BGR, producing garbage. fix: accept only biBitCount 24 and 32",
		).toBe(false);
	});

	it("refuses a DIB whose pixel data is shorter than the header claims", () => {
		const dib = buildDib({ width: 4, height: 4, bitCount: 24, rows: [], truncate: 20 });
		const result = clipboardImageToPng(dib);
		expect(
			result.ok,
			"cause: a truncated DIB was converted, reading past the buffer. fix: check pixelStart + stride*height against the buffer length",
		).toBe(false);
	});

	it("refuses bytes that are neither PNG nor a plausible DIB", () => {
		const result = clipboardImageToPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
		expect(
			result.ok,
			"cause: arbitrary bytes were accepted as a DIB. fix: validate biSize against the known header sizes",
		).toBe(false);
	});
});
