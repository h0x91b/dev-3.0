/**
 * Put box-drawing, block and powerline glyphs on the same integer cell box the
 * cell background is painted on.
 *
 * ghostty-web derives the cell from the INK box of a capital "M" — `measureFont`
 * is `Math.ceil(ascent + descent) + 2` tall and `Math.ceil(advance)` wide — but
 * draws every glyph into the font's own line box at the font's own advance. The
 * two boxes disagree on both axes: at 14px JetBrains Mono the cell is 16px tall
 * against an 18px line box, and 9px wide against an 8.4px advance. So a
 * powerline cap lands 2.5px above the background segment it is supposed to join,
 * and each full block leaves a 0.6px seam against its neighbour.
 *
 * Native Ghostty avoids this by constraining these glyphs to the cell. This does
 * the same, for exactly the codepoints that are meant to touch the cell edges,
 * and clips to the cell so nothing bleeds into the row above. Ordinary text is
 * left on the vendor's own path.
 */

/** The cell fields the fit reads; everything else is forwarded to the vendor. */
interface FitCell {
	codepoint: number;
	width: number;
	grapheme_len: number;
}

interface CellMetrics {
	width: number;
	height: number;
	baseline: number;
}

/**
 * The renderer surface, reached by cast rather than by type: `renderCellText`,
 * `fontSize` and `fontFamily` are `private` on `CanvasRenderer`, so a structural
 * interface would not accept it.
 */
interface FittableRenderer {
	renderCellText(cell: FitCell, col: number, row: number): void;
	getMetrics(): CellMetrics;
	getCanvas(): HTMLCanvasElement;
	fontSize?: number;
	fontFamily?: string;
}

const ORIGINAL_RENDER_CELL_TEXT = Symbol.for("dev3.terminalGlyphCellFit.originalRenderCellText");

type WrappedRenderer = FittableRenderer & {
	[ORIGINAL_RENDER_CELL_TEXT]?: FittableRenderer["renderCellText"];
};

export interface GlyphCellFit {
	/** Restore the vendor's own glyph painting. Safe to call twice. */
	dispose(): void;
}

/**
 * Whether this codepoint is one the cell fit reshapes. The glyph atlas asks,
 * because a cached flat raster of a powerline cap would undo the fit and put the
 * hairline back — the ranges must not be copied into a second place.
 */
export function isCellFittedGlyph(codepoint: number): boolean {
	return fitKindFor(codepoint) !== null;
}

/**
 * How a glyph's source box is chosen:
 * - `ink` — the glyph's ink covers the whole design box by definition (a full
 *   block, a powerline separator), so fitting the ink box lands it exactly on
 *   the cell.
 * - `line-box` — the glyph only covers part of the cell (upper half block, box
 *   corner, shade), so the font's line box is fitted instead and the glyph keeps
 *   its proportions inside the cell.
 */
type FitKind = "ink" | "line-box";

export function fitKindFor(codepoint: number): FitKind | null {
	if (codepoint === 0x2588) return "ink";
	if (codepoint >= 0xe0b0 && codepoint <= 0xe0bf) return "ink";
	// Box drawing + block elements, then the Nerd Fonts powerline-extra shapes.
	if (codepoint >= 0x2500 && codepoint <= 0x259f) return "line-box";
	if (codepoint >= 0xe0c0 && codepoint <= 0xe0d7) return "line-box";
	return null;
}

/** The box the glyph is drawn into today, measured from the baseline. */
interface SourceBox {
	/** Distance from the baseline up to the top of the box. */
	top: number;
	height: number;
	advance: number;
}

const sourceBoxes = new Map<string, SourceBox | null>();
let measuringCtx: CanvasRenderingContext2D | null | undefined;

function measureSourceBox(font: string, glyph: string, kind: FitKind): SourceBox | null {
	// The line box is the same for every glyph in the font, so it is cached per
	// font; an ink box has to be cached per glyph.
	const key = kind === "ink" ? `${font} ${glyph}` : font;
	const cached = sourceBoxes.get(key);
	if (cached !== undefined) return cached;

	if (measuringCtx === undefined) measuringCtx = document.createElement("canvas").getContext("2d");
	const box = measuringCtx ? readSourceBox(measuringCtx, font, glyph, kind) : null;
	sourceBoxes.set(key, box);
	return box;
}

function readSourceBox(
	ctx: CanvasRenderingContext2D,
	font: string,
	glyph: string,
	kind: FitKind,
): SourceBox | null {
	ctx.font = font;
	// "M" for the line box, because that is the character the vendor measured the
	// cell from — its advance is the one `Math.ceil`'d into cellWidth.
	const metrics = ctx.measureText(kind === "ink" ? glyph : "M");
	const top = kind === "ink" ? metrics.actualBoundingBoxAscent : metrics.fontBoundingBoxAscent;
	const bottom = kind === "ink" ? metrics.actualBoundingBoxDescent : metrics.fontBoundingBoxDescent;
	const height = top + bottom;
	const advance = metrics.width;
	// A missing or degenerate measurement would scale the glyph to NaN.
	if (!Number.isFinite(top) || !(height > 0) || !(advance > 0)) return null;
	return { top, height, advance };
}

/**
 * One device pixel, in the CSS pixels the renderer draws in. The renderer applies
 * `ctx.scale(dpr, dpr)` once, so the live transform carries it.
 */
function devicePixel(ctx: CanvasRenderingContext2D): [number, number] {
	const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
	const scaleX = transform && transform.a > 0 ? transform.a : 1;
	const scaleY = transform && transform.d > 0 ? transform.d : 1;
	return [1 / scaleX, 1 / scaleY];
}

/** Drops every cached measurement. Exported for tests; fonts are immutable at runtime. */
export function clearGlyphCellFitCache(): void {
	sourceBoxes.clear();
	measuringCtx = undefined;
}

export function installGlyphCellFit(renderer: object): GlyphCellFit {
	const target = renderer as WrappedRenderer;
	let canvasCtx: CanvasRenderingContext2D | null | undefined;

	if (!target[ORIGINAL_RENDER_CELL_TEXT] && typeof target.renderCellText === "function") {
		const original = target.renderCellText;
		target[ORIGINAL_RENDER_CELL_TEXT] = original;
		target.renderCellText = function fittedRenderCellText(
			this: FittableRenderer,
			cell: FitCell,
			col: number,
			row: number,
		) {
			// Wide cells and multi-codepoint graphemes are none of these glyphs, and
			// fitting one would distort it.
			const kind = cell && cell.grapheme_len === 0 && cell.width === 1 ? fitKindFor(cell.codepoint) : null;
			if (!kind) {
				original.call(this, cell, col, row);
				return;
			}
			if (canvasCtx === undefined) canvasCtx = this.getCanvas().getContext("2d");
			const box = canvasCtx
				? measureSourceBox(`${this.fontSize}px ${this.fontFamily}`, String.fromCodePoint(cell.codepoint), kind)
				: null;
			if (!canvasCtx || !box) {
				original.call(this, cell, col, row);
				return;
			}

			const metrics = this.getMetrics();
			const x = col * metrics.width;
			const y = row * metrics.height;
			// A full-cell glyph is grown by one device pixel past every edge and cut
			// back by the clip. Landing the measured ink exactly on the cell edge
			// instead leaves the outermost device row only ~76% covered at font size
			// 20 — a hairline between vertically stacked blocks. Partial glyphs get no
			// padding: growing an upper-half block would just make it the wrong size.
			const [padX, padY] = kind === "ink" ? devicePixel(canvasCtx) : [0, 0];
			const scaleX = (metrics.width + 2 * padX) / box.advance;
			const scaleY = (metrics.height + 2 * padY) / box.height;
			canvasCtx.save();
			canvasCtx.beginPath();
			canvasCtx.rect(x, y, metrics.width, metrics.height);
			canvasCtx.clip();
			// The vendor draws at (x, y + baseline); these three steps map the box it
			// draws into onto the cell box, anchored at the cell's own origin.
			canvasCtx.translate(x - padX, y - padY + (box.top - metrics.baseline) * scaleY);
			canvasCtx.scale(scaleX, scaleY);
			canvasCtx.translate(-x, -y);
			original.call(this, cell, col, row);
			canvasCtx.restore();
		};
	}

	return {
		dispose() {
			const original = target[ORIGINAL_RENDER_CELL_TEXT];
			if (!original) return;
			target.renderCellText = original;
			delete target[ORIGINAL_RENDER_CELL_TEXT];
		},
	};
}

export function isGlyphCellFitInstalled(renderer: object): boolean {
	return (renderer as WrappedRenderer)[ORIGINAL_RENDER_CELL_TEXT] !== undefined;
}
