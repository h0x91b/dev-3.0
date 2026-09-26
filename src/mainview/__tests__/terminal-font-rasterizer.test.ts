import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasRenderer, CellFlags } from "ghostty-web";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cell, recordingCtx } from "../terminal-bidi/__tests__/fixtures";
import { installCellLineBox } from "../terminal-cell-metrics";
import { installGlyphAtlas } from "../terminal-glyph-atlas";
import type { AtlasRenderer } from "../terminal-glyph-atlas";
import { installGlyphCellFit } from "../terminal-glyph-cell-fit";
import {
	drawNativeTerminalText, installNativeTerminalText,
	nativeTerminalCellMetrics, prepareTerminalFontRasterizer,
} from "../terminal-font-rasterizer";

const FAMILY = "Native rasterizer fixture";
const FONT = `"${FAMILY}"`;
const images = new WeakMap<HTMLCanvasElement, ImageData>();
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
const sheet = document.createElement("style");
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const nativeErrors = vi.hoisted(() => ({ load: 0, render: 0 }));

vi.mock("@zkl2333/freetype-wasm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@zkl2333/freetype-wasm")>();
	return {
		...actual,
		default: async (options: Parameters<typeof actual.default>[0]) => {
			const ft = await actual.default(options);
			const wrap = ft.module.cwrap.bind(ft.module);
			ft.module.cwrap = (name: string, ...args: unknown[]) => {
				const fn = wrap(name, ...args);
				if (name === "FT_Load_Glyph") return (...values: number[]) => nativeErrors.load || fn(...values);
				if (name === "FT_Render_Glyph") return (...values: number[]) => nativeErrors.render || fn(...values);
				return fn;
			};
			return ft;
		},
	};
});

beforeAll(async () => {
	vi.stubGlobal("ImageData", class {
		constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		let ctx = contexts.get(this);
		if (!ctx) {
			const canvas = this;
			const recorder = recordingCtx();
			recorder.ctx.putImageData = (image: ImageData) => images.set(canvas, image);
			ctx = recorder.ctx as unknown as CanvasRenderingContext2D;
			contexts.set(this, ctx);
		}
		return ctx;
	});
	vi.stubGlobal("fetch", async (input: string) => {
		let asset: string;
		if (input.endsWith("freetype.wasm")) {
			asset = createRequire(import.meta.url).resolve("@zkl2333/freetype-wasm/freetype.wasm");
		} else if (input.endsWith("native-regular.woff2")) {
			asset = resolve(fixtureDirectory, "../assets/fonts/JetBrainsMonoNerdFontMono-Regular.woff2");
		} else if (input.endsWith("native-bold.woff2")) {
			asset = resolve(fixtureDirectory, "../assets/fonts/JetBrainsMonoNerdFontMono-Bold.woff2");
		} else throw new Error(`Unexpected test asset: ${input}`);
		return new Response(new Uint8Array(readFileSync(asset)).buffer);
	});
	sheet.textContent = `
		@font-face { font-family: "${FAMILY}"; font-weight: 400; src: url("/native-regular.woff2"); }
		@font-face { font-family: "${FAMILY}"; font-weight: 700; src: url("/native-bold.woff2"); }
	`;
	document.head.append(sheet);
	await prepareTerminalFontRasterizer(FONT);
});

afterAll(() => {
	sheet.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function paint(text: string, prefix = ""): { image: ImageData; placement: number[] } {
	const ctx = document.createElement("canvas").getContext("2d")!;
	ctx.font = `${prefix}16px ${FONT}`;
	ctx.fillStyle = "#cdd6f4";
	let drawn: { image: ImageData; placement: number[] } | undefined;
	ctx.drawImage = ((source: HTMLCanvasElement, ...placement: number[]) => {
		const image = images.get(source);
		if (!image) throw new Error("Native glyph did not produce a bitmap");
		drawn = { image, placement };
	}) as CanvasRenderingContext2D["drawImage"];
	if (!drawNativeTerminalText(ctx, text, 0, 16.8, 1.25) || !drawn) {
		throw new Error("Expected the bundled font to render this glyph");
	}
	return drawn;
}

// Masks independently reproduced from Windows WezTerm with FreeType 2.13.2,
// the same font bytes, 20 physical pixels, and NO_HINTING.
describe("native terminal rasterization", () => {
	it.each([
		["regular", "", 10, [21, 152, 99, 0, 0, 0, 0, 99, 152, 21], [36, 255, 168, 0, 0, 0, 0, 168, 255, 36], 15356],
		["bold", "bold ", 10, [68, 152, 152, 7, 0, 0, 7, 152, 152, 68], [116, 255, 255, 12, 0, 0, 12, 255, 255, 116], 20882],
		["italic", "italic ", 13, [0, 0, 0, 42, 152, 78, 0, 0, 0, 0, 120, 149, 2], [0, 0, 0, 215, 242, 2, 0, 0, 0, 91, 255, 113, 0], 15341],
	] as const)("preserves the native %s H mask instead of browser hinting", (_name, prefix, width, top, stem, coverage) => {
		const { image, placement } = paint("H", prefix);
		const alpha = Array.from(image.data).filter((_value, index) => index % 4 === 3);
		expect({
			width: image.width, height: image.height, top: alpha.slice(0, width),
			stem: alpha.slice(3 * width, 4 * width), coverage: alpha.reduce((sum, value) => sum + value, 0),
			placement,
		}).toEqual({ width, height: 15, top, stem, coverage, placement: [0.8, 4.8, width / 1.25, 12] });
	});

	it("keeps every row and baseline on the native device-pixel grid", () => {
		expect(nativeTerminalCellMetrics(FONT, 16, 1.25)).toEqual({ width: 9.6, height: 21.6, baseline: 16.8 });
	});

	it("renders decomposed accents with the same native coverage as precomposed text", () => {
		const composed = paint("é");
		const decomposed = paint("e\u0301");
		expect(Array.from(decomposed.image.data)).toEqual(Array.from(composed.image.data));
		expect(decomposed.placement).toEqual(composed.placement);
	});

	it.each([0, -2, 0.375])("keeps font-derived decorations when vendor coordinates shift by %s CSS pixels", (offset) => {
		const renderer = new CanvasRenderer(document.createElement("canvas"), {
			fontFamily: FONT, fontSize: 16, devicePixelRatio: 1.25, cursorBlink: false,
		});
		const ctx = renderer.getCanvas().getContext("2d")!;
		let start = [0, 0];
		let end = [0, 0];
		const strokes: number[][] = [];
		ctx.moveTo = (x, y) => { start = [x * 1.25, y * 1.25]; };
		ctx.lineTo = (x, y) => { end = [x * 1.25, y * 1.25]; };
		ctx.stroke = () => { strokes.push([...start, ...end, ctx.lineWidth * 1.25]); };
		const metrics = installCellLineBox(renderer);
		const target = renderer as unknown as AtlasRenderer;
		const vendorCell = target.renderCellText;
		target.renderCellText = function (cell, col, row) {
			const move = ctx.moveTo;
			const line = ctx.lineTo;
			ctx.moveTo = (x, y) => move.call(ctx, x, y + offset);
			ctx.lineTo = (x, y) => line.call(ctx, x, y + offset);
			try { vendorCell.call(this, cell, col, row); }
			finally { ctx.moveTo = move; ctx.lineTo = line; }
		};
		const native = installNativeTerminalText(renderer);
		const fit = installGlyphCellFit(renderer);
		const atlas = installGlyphAtlas(renderer as unknown as AtlasRenderer);
		try {
			(renderer as unknown as AtlasRenderer).renderCellText(
				cell("H", { flags: CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH }), 2, 3,
			);
			const expected = [[24, 105.5, 36, 105.5, 1], [24, 93.5, 36, 93.5, 1]];
			expect(strokes).toEqual(expected.map((line) => line.map((value) => expect.closeTo(value, 10))));
		} finally {
			atlas.dispose(); fit.dispose(); native.dispose(); metrics.dispose(); renderer.dispose();
		}
	});

	it.each(["load", "render"] as const)("paints browser fallback after a FreeType %s error and continues the frame", (operation) => {
		const renderer = new CanvasRenderer(document.createElement("canvas"), {
			fontFamily: FONT, fontSize: 16, devicePixelRatio: 1.25, cursorBlink: false,
		});
		const ctx = renderer.getCanvas().getContext("2d")!;
		const fallback = vi.fn();
		const painted: ImageData[] = [];
		ctx.fillText = fallback;
		ctx.drawImage = ((source: HTMLCanvasElement) => { painted.push(images.get(source)!); }) as typeof ctx.drawImage;
		const metrics = installCellLineBox(renderer);
		const native = installNativeTerminalText(renderer);
		try {
			nativeErrors[operation] = 6;
			(renderer as unknown as AtlasRenderer).renderCellText(cell("X"), 0, 0);
			nativeErrors[operation] = 0;
			(renderer as unknown as AtlasRenderer).renderCellText(cell("H"), 1, 0);
			expect(fallback.mock.calls.map(([text]) => text)).toEqual(["X"]);
			expect(painted.map(image => [image.width, image.height])).toEqual([[10, 15]]);
		} finally {
			nativeErrors[operation] = 0;
			native.dispose(); metrics.dispose(); renderer.dispose();
		}
	});

	it("retries font preparation after a transient WASM fetch failure", async () => {
		vi.resetModules();
		const rasterizer = await import("../terminal-font-rasterizer");
		const request = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Offline"));
		try {
			await expect(rasterizer.prepareTerminalFontRasterizer(FONT)).rejects.toThrow("Offline");
			await rasterizer.prepareTerminalFontRasterizer(FONT);
			expect(rasterizer.nativeTerminalCellMetrics(FONT, 16, 1.25)).toEqual({
				width: 9.6, height: 21.6, baseline: 16.8,
			});
		} finally { request.mockRestore(); }
	});

	it("releases invalidated glyph canvases when another font loads without changing subsequent text", async () => {
		vi.resetModules();
		const rasterizer = await import("../terminal-font-rasterizer");
		await rasterizer.prepareTerminalFontRasterizer(FONT);
		const ctx = document.createElement("canvas").getContext("2d")!;
		ctx.font = `16px ${FONT}`;
		ctx.fillStyle = "#cdd6f4";
		const sources: HTMLCanvasElement[] = [];
		ctx.drawImage = ((source: HTMLCanvasElement) => { sources.push(source); }) as typeof ctx.drawImage;
		rasterizer.drawNativeTerminalText(ctx, "H", 0, 16.8, 1.25);
		const original = sources[0];
		const bitmap = images.get(original);
		const extra = document.createElement("style");
		extra.textContent = '@font-face { font-family: "Second fixture"; src: url("/native-regular.woff2"); }';
		document.head.append(extra);
		try {
			await rasterizer.prepareTerminalFontRasterizer('"Second fixture"');
			expect([original.width, original.height]).toEqual([0, 0]);
			rasterizer.drawNativeTerminalText(ctx, "H", 0, 16.8, 1.25);
			expect(images.get(sources[1])).toEqual(bitmap);
		} finally { extra.remove(); }
	});
});
