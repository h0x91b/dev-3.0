import initFreeType, { FT } from "@zkl2333/freetype-wasm";
import type { Face, FaceInfo, FreeType } from "@zkl2333/freetype-wasm";
import wasmUrl from "@zkl2333/freetype-wasm/freetype.wasm?url";
import type { GhosttyCell } from "ghostty-web";
import { drawTerminalBox, isTerminalBoxGlyph } from "./terminal-box-drawing";

interface FontFamily {
	regular: Face;
	bold: Face;
	info: FaceInfo;
	underlinePosition: number;
	underlineThickness: number;
}

interface Glyph {
	canvas: HTMLCanvasElement;
	left: number;
	top: number;
	bytes: number;
}

interface FontStyle {
	family: FontFamily;
	size: number;
	bold: boolean;
	italic: boolean;
	colours: Map<string, Map<string, Glyph>>;
	underlineRow: number;
	underlineThickness: number;
}

interface NativeApi {
	load: (face: number, index: number, flags: number) => number;
	render: (slot: number, mode: number) => number;
	embolden: (slot: number) => void;
	transform: (face: number, matrix: number, delta: number) => void;
	matrix: number;
}

const MAX_GLYPH_BYTES = 8 * 1024 * 1024;
const MAX_GLYPHS = 8192;
const families = new Map<string, FontFamily>();
const pendingFamilies = new Map<string, Promise<void>>();
const styles = new Map<number, Map<string, FontStyle | null>>();
const glyphOrder = new Map<Glyph, {
	owner: Map<string, Glyph>; text: string; style: FontStyle; colour: string;
}>();
let glyphBytes = 0;
let library: FreeType | undefined;
let libraryPromise: Promise<FreeType> | undefined;
let native: NativeApi;

function firstFamily(stack: string): string {
	return (stack.match(/^\s*(['"])(.*?)\1/)?.[2] ?? stack.split(",", 1)[0]).trim();
}

function fontSources(family: string): { regular: string; bold?: string } | null {
	let regular: string | undefined;
	let bold: string | undefined;
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try { rules = sheet.cssRules; } catch { continue; }
		for (const rule of rules) {
			if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
			const face = rule as CSSFontFaceRule;
			if (firstFamily(face.style.fontFamily) !== family || face.style.fontStyle === "italic") continue;
			const source = face.style.getPropertyValue("src").match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1];
			if (!source) continue;
			const url = new URL(source, sheet.href ?? document.baseURI).href;
			if (face.style.fontWeight === "700" || face.style.fontWeight === "bold") bold = url;
			else regular = url;
		}
	}
	return regular ? { regular, bold } : null;
}

async function freeType(): Promise<FreeType> {
	libraryPromise ??= fetch(wasmUrl).then(async (response) => {
		if (!response.ok) throw new Error(`Terminal rasterizer request failed (${response.status})`);
		// Explicit bytes work with both browser and desktop assets regardless of their MIME type.
		return initFreeType({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
	}).then((ft) => {
		const module = ft.module;
		native = {
			load: module.cwrap("FT_Load_Glyph", "number", ["number", "number", "number"]),
			render: module.cwrap("FT_Render_Glyph", "number", ["number", "number"]),
			embolden: module.cwrap("FT_GlyphSlot_Embolden", null, ["number"]),
			transform: module.cwrap("FT_Set_Transform", null, ["number", "number", "number"]),
			matrix: module._malloc(16),
		};
		library = ft;
		return ft;
	}).catch((error) => {
		libraryPromise = undefined;
		throw error;
	});
	return libraryPromise;
}

export function prepareTerminalFontRasterizer(stack: string): Promise<void> {
	const family = firstFamily(stack);
	if (families.has(family)) return Promise.resolve();
	const pending = pendingFamilies.get(family);
	if (pending) return pending;
	const sources = fontSources(family);
	// Local system fonts have no browser-readable font bytes; retain their native rendering.
	if (!sources) return Promise.resolve();
	const loadFace = async (url: string, ft: FreeType) => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Terminal font request failed (${response.status})`);
		return ft.newFace(await response.arrayBuffer());
	};
	const loading = freeType().then(async (ft) => {
		const regular = await loadFace(sources.regular, ft);
		try {
			const bold = sources.bold ? await loadFace(sources.bold, ft) : regular;
			const fields = ft.offsets.FT_FaceRec;
			families.set(family, {
				regular, bold, info: regular.info(),
				underlinePosition: ft.module.getValue(regular.ptr + fields.underline_position, "i16"),
				underlineThickness: ft.module.getValue(regular.ptr + fields.underline_thickness, "i16"),
			});
			for (const glyph of glyphOrder.keys()) glyph.canvas.width = glyph.canvas.height = 0;
			glyphOrder.clear();
			glyphBytes = 0;
			styles.clear();
		} catch (error) {
			regular.destroy();
			throw error;
		}
	}).finally(() => pendingFamilies.delete(family));
	pendingFamilies.set(family, loading);
	return loading;
}

export function nativeTerminalCellMetrics(stack: string, size: number, ratio: number) {
	const family = families.get(firstFamily(stack));
	if (!family || !(size > 0) || !(ratio > 0)) return null;
	const pixels = size * ratio;
	const info = family.info;
	family.regular.setCharSize(0, Math.round(pixels * 64), 72, 72);
	const advance = family.regular.loadGlyph({ char: 77, flags: FT.LOAD_NO_HINTING, render: false }).advance.x / 64;
	return {
		width: Math.max(1, Math.round(advance)) / ratio,
		height: Math.ceil(info.height * pixels / info.unitsPerEM) / ratio,
		baseline: Math.ceil(info.ascender * pixels / info.unitsPerEM) / ratio,
	};
}

function resolveStyle(font: string, ratio: number): FontStyle | null {
	let byFont = styles.get(ratio);
	if (!byFont) { byFont = new Map(); styles.set(ratio, byFont); }
	if (byFont.has(font)) return byFont.get(font)!;
	const parsed = font.match(/^(.*?)\b([\d.]+)px\s+(.+)$/);
	const family = parsed && families.get(firstFamily(parsed[3]));
	const size = parsed ? Number(parsed[2]) * ratio : 0;
	const scale = family ? size / family.info.unitsPerEM : 0;
	const style = parsed && family ? {
		family, size,
		bold: /\b(?:bold|[6-9]00)\b/.test(parsed[1]),
		italic: /\b(?:italic|oblique)\b/.test(parsed[1]),
		colours: new Map<string, Map<string, Glyph>>(),
		underlineRow: Math.trunc(Math.ceil(family.info.height * scale)
			+ (family.info.descender - family.underlinePosition) * scale),
		underlineThickness: Math.max(1, Math.round(family.underlineThickness * scale)),
	} : null;
	byFont.set(font, style);
	return style;
}

function rasterize(style: FontStyle, codepoint: number, colour: string): Glyph | null {
	const face = style.bold ? style.family.bold : style.family.regular;
	const index = face.charIndex(codepoint);
	if (!index) return null;
	const rgb = /^#([\da-f]{6})$/i.exec(colour);
	const functional = rgb ? null : /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(colour);
	if (!rgb && !functional) return null;
	const packed = rgb ? parseInt(rgb[1], 16) : 0;
	const red = rgb ? packed >> 16 : Number(functional![1]);
	const green = rgb ? (packed >> 8) & 255 : Number(functional![2]);
	const blue = rgb ? packed & 255 : Number(functional![3]);
	const opacity = functional && functional[4] !== undefined ? Number(functional[4]) : 1;
	const ft = library!;
	const module = ft.module;
	face.setCharSize(0, Math.round(style.size * 64), 72, 72);
	module.setValue(native.matrix, 65536, "i32");
	module.setValue(native.matrix + 4, style.italic ? 13107 : 0, "i32");
	module.setValue(native.matrix + 8, 0, "i32");
	module.setValue(native.matrix + 12, 65536, "i32");
	native.transform(face.ptr, native.matrix, 0);
	const loadError = native.load(face.ptr, index, FT.LOAD_NO_HINTING);
	if (loadError) return null;
	const slot = module.getValue(face.ptr + ft.offsets.FT_FaceRec.glyph, "i32");
	if (style.bold && style.family.bold === style.family.regular) native.embolden(slot);
	const renderError = native.render(slot, FT.RENDER_MODE_NORMAL);
	if (renderError) return null;
	const fields = ft.offsets.FT_GlyphSlotRec;
	const bitmap = slot + fields.bitmap;
	const offsets = ft.offsets.FT_Bitmap;
	const width = module.getValue(bitmap + offsets.width, "i32");
	const height = module.getValue(bitmap + offsets.rows, "i32");
	const pitch = module.getValue(bitmap + offsets.pitch, "i32");
	const pixels = module.getValue(bitmap + offsets.buffer, "i32");
	if (module.getValue(bitmap + offsets.pixel_mode, "i8") !== FT.PIXEL_MODE_GRAY) return null;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	if (width && height) {
		const rgba = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			const source = pixels + (pitch >= 0 ? y : height - 1 - y) * Math.abs(pitch);
			for (let x = 0; x < width; x++) {
				const target = (y * width + x) * 4;
				rgba[target] = red;
				rgba[target + 1] = green;
				rgba[target + 2] = blue;
				rgba[target + 3] = Math.round(module.HEAPU8[source + x] * opacity);
			}
		}
		canvas.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
	}
	return {
		canvas, bytes: width * height * 4,
		left: module.getValue(slot + fields.bitmap_left, "i32"),
		top: module.getValue(slot + fields.bitmap_top, "i32"),
	};
}

export function drawNativeTerminalText(
	ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ratio: number,
): boolean {
	const style = resolveStyle(ctx.font, ratio);
	if (!style || typeof ctx.fillStyle !== "string") return false;
	const normalized = text.length > (text.codePointAt(0)! > 0xffff ? 2 : 1) ? text.normalize("NFC") : text;
	const codepoint = normalized.codePointAt(0);
	if (codepoint === undefined) return true;
	// Leave shaped clusters and missing glyphs to the browser's font fallback and shaper.
	if (normalized.length !== (codepoint > 0xffff ? 2 : 1)) return false;
	let colour = style.colours.get(ctx.fillStyle);
	let glyph = colour?.get(normalized);
	if (!glyph) {
		glyph = rasterize(style, codepoint, ctx.fillStyle) ?? undefined;
		if (!glyph) return false;
		if (!colour) { colour = new Map(); style.colours.set(ctx.fillStyle, colour); }
		colour.set(normalized, glyph);
		glyphOrder.set(glyph, { owner: colour, text: normalized, style, colour: ctx.fillStyle });
		glyphBytes += glyph.bytes;
		while ((glyphBytes > MAX_GLYPH_BYTES || glyphOrder.size > MAX_GLYPHS) && glyphOrder.size > 1) {
			const [old, entry] = glyphOrder.entries().next().value!;
			entry.owner.delete(entry.text);
			if (entry.owner.size === 0) entry.style.colours.delete(entry.colour);
			glyphOrder.delete(old);
			glyphBytes -= old.bytes;
			old.canvas.width = old.canvas.height = 0;
		}
	}
	if (glyph.canvas.width && glyph.canvas.height) {
		ctx.drawImage(glyph.canvas,
			(Math.round(x * ratio) + glyph.left) / ratio,
			(Math.round(y * ratio) - glyph.top) / ratio,
			glyph.canvas.width / ratio, glyph.canvas.height / ratio);
	}
	return true;
}

interface NativeRenderer {
	ctx: CanvasRenderingContext2D;
	devicePixelRatio: number;
	fontSize: number;
	metrics: { width: number; height: number; baseline: number };
	renderCellText(cell: GhosttyCell, col: number, row: number): void;
}

interface NativeTextHandle { dispose(): void }
const installedRenderers = new WeakMap<object, NativeTextHandle>();

export function isNativeTerminalTextInstalled(renderer: object): boolean {
	return installedRenderers.has(renderer);
}

export function installNativeTerminalText(renderer: object): NativeTextHandle {
	const installed = installedRenderers.get(renderer);
	if (installed) return installed;
	const target = renderer as NativeRenderer;
	const ctx = target.ctx;
	const originalText = ctx.fillText;
	const originalCell = target.renderCellText;
	const originalMove = ctx.moveTo;
	const originalLine = ctx.lineTo;
	const originalStroke = ctx.stroke;
	const stroke = originalStroke.bind(ctx);
	let activeRow: number | null = null;
	let decoration: FontStyle | null = null;

	ctx.fillText = function nativeFillText(text, x, y, maxWidth) {
		const ratio = target.devicePixelRatio;
		if (maxWidth === undefined && text.length === 1 && isTerminalBoxGlyph(text.charCodeAt(0))) {
			const style = resolveStyle(this.font, ratio);
			const metrics = target.metrics;
			drawTerminalBox(this, text.charCodeAt(0), x, y - metrics.baseline,
				metrics.width, metrics.height, ratio,
				style?.underlineThickness ?? Math.max(1, Math.round(target.fontSize * ratio / 20)));
			return;
		}
		if (maxWidth !== undefined || !drawNativeTerminalText(this, text, x, y, ratio)) {
			originalText.call(this, text, x, y, maxWidth);
		}
	};
	target.renderCellText = function nativeCellText(cell, col, row) {
		activeRow = row;
		decoration = null;
		try { originalCell.call(this, cell, col, row); }
		finally { activeRow = null; decoration = null; }
	};
	function linePosition(y: number): number {
		if (activeRow === null) return y;
		decoration ??= resolveStyle(ctx.font, target.devicePixelRatio);
		if (!decoration) return y;
		const metrics = target.metrics;
		const top = activeRow * metrics.height;
		// Classify by the baseline, not the vendor's incidental decoration offsets.
		const pixelRow = y >= top + metrics.baseline
			? decoration.underlineRow : Math.floor(decoration.underlineRow / 2);
		return top + (pixelRow + decoration.underlineThickness / 2) / target.devicePixelRatio;
	}
	ctx.moveTo = function nativeMoveTo(x, y) { originalMove.call(this, x, linePosition(y)); };
	ctx.lineTo = function nativeLineTo(x, y) { originalLine.call(this, x, linePosition(y)); };
	ctx.stroke = function nativeStroke(path?: Path2D) {
		const width = this.lineWidth;
		if (decoration) this.lineWidth = decoration.underlineThickness / target.devicePixelRatio;
		try { if (path) stroke(path); else stroke(); }
		finally { this.lineWidth = width; }
	};
	const handle: NativeTextHandle = {
		dispose() {
			if (!installedRenderers.delete(renderer)) return;
			target.renderCellText = originalCell;
			ctx.fillText = originalText;
			ctx.moveTo = originalMove;
			ctx.lineTo = originalLine;
			ctx.stroke = originalStroke;
		},
	};
	installedRenderers.set(renderer, handle);
	return handle;
}
