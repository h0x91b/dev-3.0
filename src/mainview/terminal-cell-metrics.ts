/**
 * Give the terminal cell the size native Ghostty gives it: the height the font was
 * designed to be set at, and a width quantized on the device pixel grid.
 *
 * ghostty-web derives the cell from the INK box of a capital "M":
 * `Math.ceil(actualBoundingBoxAscent + actualBoundingBoxDescent) + 2`. "M" has no
 * descender, so `actualBoundingBoxDescent` is 0 in 15 of the 16 bundled fonts and
 * a `||` fallback substitutes `fontSize * 0.2` — the ink of one capital plus a
 * guess. The font's own line metrics never enter the result, so every font ends up
 * within a pixel of the same cell: at size 16 the vendor gives 17 px for JetBrains
 * Mono (designed 21), for Hack (19), and for 0xProto (25) alike. Descenders of one
 * row then touch the next, and the same text is visibly tighter than in Ghostty,
 * Terminal.app, iTerm2 or VS Code — issue #1668.
 *
 * `fontBoundingBoxAscent + fontBoundingBoxDescent` is that designed line box. Both
 * engines that matter here agree on it: measured over 16 bundled fonts x 12 sizes,
 * Chromium and WKWebView return identical integers in all 192 pairs, and those
 * integers are the font's `hhea` ascender/descender scaled per side (verified
 * against the woff2 tables with fontTools).
 *
 * The WIDTH is the vendor's `Math.ceil(advance)` in CSS pixels, and that is a bug of
 * its own. Native Ghostty rounds the advance on the DEVICE pixel grid
 * (`@round(face_width)`, `src/font/Metrics.zig`), which is where its 9.5 px against
 * our 10 px comes from. Measured over the 16 bundled fonts at every size 8-32, at
 * the fractional sizes the reference clamp actually produces, `Math.ceil` promotes a
 * sub-hundredth measurement difference into a whole pixel: at size 15 Chromium
 * measures Hack at 8.9946 and WKWebView at 9.0001, so the desktop app grids one pixel
 * per column wider than the same font in remote mode, and both Hack and MesloLGS end
 * up WIDER than the reference font at sizes 15, 20, 25 and 30 — breaking the one
 * invariant `terminal-font.ts` exists to hold. Rounding on the device grid holds it in
 * all 400 measured pairs, in both engines, at both DPRs, with the `scale` constants
 * untouched. See `decisions/2026/09/08/cell-width-on-the-device-pixel-grid.md`.
 */

interface CellMetrics {
	width: number;
	height: number;
	baseline: number;
}

/**
 * Reached by cast, not by structural type: `measureFont` and the font fields are
 * `private` on the vendor's `CanvasRenderer`.
 */
interface MeasurableRenderer {
	measureFont(): CellMetrics;
	remeasureFont(): void;
	fontSize?: number;
	fontFamily?: string;
	/**
	 * The renderer's OWN captured ratio — read this, never `window.devicePixelRatio`.
	 * The vendor reads it once in its constructor and every later `resize()` scales
	 * the canvas by that captured value, so a cell sized from the live window ratio
	 * would disagree with the canvas transform the moment a window moves to a display
	 * of a different scale. Reading the same field keeps the two in lockstep: after a
	 * monitor switch both are equally stale until the pane is rebuilt, which is
	 * already true of the canvas today and is not this module's to fix.
	 */
	devicePixelRatio?: number;
}

const ORIGINAL_MEASURE_FONT = Symbol.for("dev3.terminalCellMetrics.originalMeasureFont");

type WrappedRenderer = MeasurableRenderer & {
	[ORIGINAL_MEASURE_FONT]?: MeasurableRenderer["measureFont"];
};

export interface CellLineBox {
	/** Restore the vendor's own cell metrics and remeasure. Safe to call twice. */
	dispose(): void;
}

/**
 * The font's designed line box, in whole CSS pixels, or null when the engine
 * cannot answer. Each side is ceiled on its own so neither the ascent nor the
 * descent is ever cropped by THIS code; both engines were measured returning
 * integers already — in all 400 font/size pairs, fractional sizes included — so in
 * practice the ceil never binds and the quantization is the engine's own.
 */
export function lineBoxCell(metrics: TextMetrics): { height: number; baseline: number } | null {
	const ascent = metrics.fontBoundingBoxAscent;
	const descent = metrics.fontBoundingBoxDescent;
	if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return null;
	if (!(ascent > 0) || descent < 0) return null;
	const baseline = Math.ceil(ascent);
	const height = baseline + Math.ceil(descent);
	return { height, baseline };
}

/**
 * The advance quantized on the device pixel grid, the way native Ghostty does it, or
 * null when there is nothing better than the vendor's own number.
 *
 * A fractional CSS result is intended: at a ratio of 2, `9.5` is a whole 19 device
 * pixels, which is the point. At ratio 1 the result is always an integer, so nothing
 * downstream sees a fraction on a non-retina display.
 *
 * `Math.round` matches Ghostty's `@round`, and so does its cost: a cell can land up
 * to half a device pixel narrower than the glyph advance. Ghostty accepts that
 * deliberately — the only glyphs that fill their advance edge to edge are the ones
 * meant to join their neighbours, and `terminal-glyph-cell-fit.ts` already pins
 * exactly those to the cell.
 */
export function deviceGridWidth(advance: number, ratio: number | undefined): number | null {
	if (!Number.isFinite(advance) || !(advance > 0)) return null;
	if (!Number.isFinite(ratio) || !(ratio! > 0)) return null;
	return Math.max(1, Math.round(advance * ratio!)) / ratio!;
}

let measuringCtx: CanvasRenderingContext2D | null | undefined;

/** Drops the cached measuring context. Exported for tests. */
export function clearCellMetricsCache(): void {
	measuringCtx = undefined;
}

export function installCellLineBox(renderer: object): CellLineBox {
	const target = renderer as WrappedRenderer;

	if (!target[ORIGINAL_MEASURE_FONT] && typeof target.measureFont === "function") {
		const original = target.measureFont;
		target[ORIGINAL_MEASURE_FONT] = original;
		target.measureFont = function lineBoxMeasureFont(this: MeasurableRenderer): CellMetrics {
			const vendor = original.call(this);
			if (measuringCtx === undefined) measuringCtx = document.createElement("canvas").getContext("2d");
			if (!measuringCtx) return vendor;
			measuringCtx.font = `${this.fontSize}px ${this.fontFamily}`;
			// "M" is what the vendor measures, and for every bundled font it is also the
			// widest printable ASCII advance — the quantity Ghostty takes its cell from.
			const metrics = measuringCtx.measureText("M");
			const box = lineBoxCell(metrics);
			const width = deviceGridWidth(metrics.width, this.devicePixelRatio);
			// A degenerate measurement must not shrink the terminal to nothing: the
			// vendor's own cell, wrong as it is, still renders. Each axis falls back on
			// its own, so one bad number cannot drag the other back.
			if (!box && width === null) return vendor;
			return {
				width: width ?? vendor.width,
				height: box ? box.height : vendor.height,
				baseline: box ? box.baseline : vendor.baseline,
			};
		};
		// The constructor already measured with the vendor's formula.
		if (typeof target.remeasureFont === "function") target.remeasureFont();
	}

	return {
		dispose() {
			const original = target[ORIGINAL_MEASURE_FONT];
			if (!original) return;
			target.measureFont = original;
			delete target[ORIGINAL_MEASURE_FONT];
			if (typeof target.remeasureFont === "function") target.remeasureFont();
		},
	};
}

export function isCellLineBoxInstalled(renderer: object): boolean {
	return (renderer as WrappedRenderer)[ORIGINAL_MEASURE_FONT] !== undefined;
}
