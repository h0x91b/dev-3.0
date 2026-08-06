import { deflateSync } from "node:zlib";

/**
 * Turn whatever the host clipboard handed us into PNG bytes.
 *
 * macOS returns real PNG (NSPasteboard converts). Windows returns raw CF_DIB
 * bytes — electrobun 1.18.1 has a "TODO: implement proper PNG conversion" there
 * — so a DIB saved as `.png` is a corrupt file. PNG is the required output
 * because the consumer of the pasted path is an agent, and the Claude API
 * accepts only JPEG/PNG/GIF/WebP; a BMP would exist, open in a viewer, and be
 * unreadable exactly where it is used.
 *
 * Delete this module once electrobun's Windows `clipboardReadImage` returns PNG.
 * See decisions/2026/08/06/clipboard-image-dib-to-png.md.
 */
export type ClipboardImageResult =
	| { ok: true; png: Uint8Array }
	| { ok: false; reason: "empty" | "unsupported" };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function clipboardImageToPng(bytes: Uint8Array): ClipboardImageResult {
	if (bytes.length === 0) return { ok: false, reason: "empty" };

	if (PNG_MAGIC.every((b, i) => bytes[i] === b)) {
		return { ok: true, png: bytes };
	}

	// BMP file: 14-byte BITMAPFILEHEADER, then the DIB we know how to read.
	if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length > 14) {
		return dibToPng(bytes.subarray(14));
	}

	return dibToPng(bytes);
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;

function dibToPng(dib: Uint8Array): ClipboardImageResult {
	if (dib.length < 40) return { ok: false, reason: "unsupported" };
	const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);

	const headerSize = view.getUint32(0, true);
	// 40 = BITMAPINFOHEADER, 52/56 = +masks, 108 = V4, 124 = V5.
	if (![40, 52, 56, 108, 124].includes(headerSize)) return { ok: false, reason: "unsupported" };

	const width = view.getInt32(4, true);
	const rawHeight = view.getInt32(8, true);
	const bitCount = view.getUint16(14, true);
	const compression = view.getUint32(16, true);
	const clrUsed = view.getUint32(32, true);

	if (width <= 0 || rawHeight === 0) return { ok: false, reason: "unsupported" };
	if (bitCount !== 24 && bitCount !== 32) return { ok: false, reason: "unsupported" };
	if (compression !== BI_RGB && compression !== BI_BITFIELDS) return { ok: false, reason: "unsupported" };

	// A 40-byte header with BI_BITFIELDS carries its three masks right after it.
	const trailingMasks = compression === BI_BITFIELDS && headerSize === 40 ? 12 : 0;
	const paletteBytes = bitCount <= 8 ? (clrUsed || 1 << bitCount) * 4 : clrUsed * 4;
	const pixelStart = headerSize + trailingMasks + paletteBytes;

	const topDown = rawHeight < 0;
	const height = Math.abs(rawHeight);
	const bytesPerPixel = bitCount / 8;
	const stride = ((width * bytesPerPixel + 3) & ~3) >>> 0;
	if (pixelStart + stride * height > dib.length) return { ok: false, reason: "unsupported" };

	// 32-bit BI_RGB leaves the 4th byte undefined, so alpha is only trusted when
	// a V4/V5 header declares a non-zero alpha mask.
	const alphaMask = bitCount === 32 && headerSize >= 108 ? view.getUint32(52, true) : 0;
	const useAlpha = alphaMask !== 0;

	// One filter byte (0 = none) plus RGBA per pixel, per PNG scanline.
	const raw = new Uint8Array((1 + width * 4) * height);
	for (let y = 0; y < height; y++) {
		const srcRow = topDown ? y : height - 1 - y;
		let src = pixelStart + srcRow * stride;
		let dst = y * (1 + width * 4) + 1;
		for (let x = 0; x < width; x++) {
			raw[dst] = dib[src + 2]!; // DIB pixels are BGR(A)
			raw[dst + 1] = dib[src + 1]!;
			raw[dst + 2] = dib[src]!;
			raw[dst + 3] = useAlpha ? dib[src + 3]! : 0xff;
			src += bytesPerPixel;
			dst += 4;
		}
	}

	return { ok: true, png: encodePng(width, height, raw) };
}

function encodePng(width: number, height: number, rawScanlines: Uint8Array): Uint8Array {
	const ihdr = new Uint8Array(13);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, width);
	ihdrView.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA
	// [10] compression, [11] filter, [12] interlace — all 0.

	const chunks = [
		new Uint8Array(PNG_MAGIC),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", new Uint8Array(deflateSync(rawScanlines))),
		pngChunk("IEND", new Uint8Array(0)),
	];
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
