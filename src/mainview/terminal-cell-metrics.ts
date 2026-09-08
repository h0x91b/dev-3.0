/**
 * Give the terminal cell the height the font was designed to be set at.
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
 * The cell WIDTH is deliberately left on the vendor's `Math.ceil` in CSS pixels.
 * Rounding it in device pixels would match Ghostty's 9.5 px more closely, but it
 * lands narrower than the glyph advance in 67 of those 192 pairs and the reference
 * clamp in `terminal-font.ts` is built on the ceil — see
 * `decisions/2026/09/08/cell-height-from-the-font-line-box.md`.
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
 * descent is ever cropped; Chromium and WebKit already hand over integers, so the
 * ceil only guards an engine that does not.
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
			const box = lineBoxCell(measuringCtx.measureText("M"));
			// A degenerate measurement must not shrink the terminal to nothing: the
			// vendor's own cell, wrong as it is, still renders.
			if (!box) return vendor;
			return { width: vendor.width, height: box.height, baseline: box.baseline };
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
