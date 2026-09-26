/**
 * Glyph atlas for ghostty-web's canvas renderer.
 *
 * **Why.** WebKit — the engine Electrobun renders dev3 in — charges per Canvas2D
 * state change, and the vendor's `renderCellText` makes two of them for every
 * cell: a new `fillStyle`, then a `fillText` that re-shapes the glyph. Measured
 * in a real WKWebView on a 200×46 grid (9200 cells), one frame:
 *
 * | one cell draws                        | ms/frame |
 * |---------------------------------------|----------|
 * | same colour, same glyph               |    13    |
 * | same colour, varying glyph            |   182    |
 * | varying colour, same glyph            |   110    |
 * | both varying — what the vendor does   |   192, with a tail to 2.3 s |
 * | this module: blit from a colour atlas |    16    |
 *
 * Chromium draws the same frame in 34 ms and hides all of it, so none of this is
 * visible in a Chromium benchmark. See the decision record
 * `glyph-atlas-for-webkit-canvas-text`.
 *
 * **How.** Each glyph is rasterised once per (colour, bold, italic) into a strip
 * canvas, then every later occurrence is a `drawImage` — no shaping, no fill
 * colour change. Strips are paged so memory tracks what the screen actually uses.
 *
 * **Sharpness rule: every rectangle `drawImage` sees is whole device pixels.** A
 * blit is only a copy when source and destination are both pixel-aligned and the
 * same size; a fraction anywhere turns it into a bilinear resample of ink that was
 * already antialiased, and the terminal goes soft. The slot geometry is therefore
 * computed in device pixels (`slotGeometry`), not in CSS pixels multiplied by the
 * ratio at blit time — which is what shipped, and why the blur only appeared at
 * fractional ratios: at ratio 1.25 a 3 px pad is 3.75 device pixels, so EVERY cell
 * blitted a quarter-pixel off. The row grid stays fractional by nature (21 CSS px
 * at 1.25 steps 26.25), and that remainder is kept in the raster as a sub-pixel
 * phase rather than rounded away — see `MAX_SUBPIXEL_PHASES`. At a whole-pixel
 * ratio there is one phase and the strips are byte-for-byte what they always were.
 *
 * **Coverage is all-or-nothing, which is why the cap is 256 and not 32.** Half a
 * screen from the atlas and half from `fillText` is worse than either alone —
 * WebKit pays for the switching. On a stable 256-colour screen, measured:
 *
 * | style cap, stable 256-colour screen | steady frame | cache hits |
 * |-------------------------------------|--------------|------------|
 * | none (vendor only) |  518 ms |   —  |
 * | 32                 |  492 ms | 12.8% |
 * | 128, no detector   |  347 ms | 49.7% |
 * | 256                |   65 ms |  100% |
 *
 * With the detector in place the middle rows stop existing: a palette that does not
 * fit is switched off rather than half-cached. Shipped configuration, measured:
 *
 * | screen                    | vendor | atlas | detector |
 * |---------------------------|--------|-------|----------|
 * | 100 colours, stable       | 214 ms |  31 ms | silent   |
 * | 256 colours, stable       | 517 ms | 534 ms | fires    |
 * | 256 colours, new each frame | 431 ms | 397 ms | fires  |
 *
 * **Safety rule: the fast path is narrow, and anything else falls through to the
 * vendor's own method.** Selection, inverse video, underline, strikethrough,
 * faint, grapheme clusters, wide cells, a hovered link's underline, the
 * block/powerline glyphs `terminal-glyph-cell-fit` reshapes, and a full atlas all
 * take the original path, so the worst this can do is perform like the code it
 * replaces.
 *
 * Installed AFTER `installGlyphCellFit`, which wraps the same method: falling
 * through then reaches the fitted wrapper rather than skipping past it.
 */

import type { GhosttyCell } from "ghostty-web";
import { isCellFittedGlyph } from "./terminal-glyph-cell-fit";
import { drawNativeTerminalText } from "./terminal-font-rasterizer";

/** Cell flag bits, read out of ghostty-web 0.4.0's `CellFlags`. */
const FLAG_BOLD = 1;
const FLAG_ITALIC = 2;
const FLAG_UNDERLINE = 4;
const FLAG_STRIKETHROUGH = 8;
const FLAG_INVERSE = 16;
const FLAG_INVISIBLE = 32;
const FLAG_FAINT = 128;

/** Everything the fast path cannot draw and must hand back to the vendor. */
const DEFERRED_FLAGS = FLAG_UNDERLINE | FLAG_STRIKETHROUGH | FLAG_FAINT | FLAG_INVISIBLE | FLAG_INVERSE;

/**
 * Glyphs per strip canvas. A page is allocated only when the one before it fills,
 * so a terminal showing 20 distinct characters pays for 32 slots, not 128.
 */
export const GLYPHS_PER_PAGE = 32;
/** Pages one (colour, style) may hold before new glyphs fall through. */
export const MAX_PAGES_PER_STYLE = 4;
/**
 * Distinct (colour, style) combinations that get an atlas.
 *
 * PARTIAL coverage is worse than none — on a stable 256-colour screen a 32-style
 * cap measured 492 ms against 88 ms with no atlas at all, because interleaving
 * `drawImage` and `fillText` costs more than doing either alone. So the cap is not
 * a throttle: it is the line past which the atlas should stop trying, and `churn`
 * below is what makes it stop rather than limp.
 *
 * 128 rather than 256 to halve the worst-case memory: measured 27 MB of strip
 * canvases on a 100-colour screen. A screen with more colours than this overflows
 * the cap every window, which the churn detector reads as a palette it cannot hold
 * and switches off — the same outcome as never having tried.
 */
export const MAX_STYLES = 128;

/**
 * Churn detector: a palette that never repeats can never be cached, and trying
 * costs a rasterisation per cell forever. term-bench is the reference case —
 * three consecutive frames shared ZERO of 1024 colours.
 *
 * Every window of cells, the atlas counts how many styles it had never seen. The
 * first window after a reset is the legitimate warm-up and is not judged; from
 * the second on, a window that is still minting styles means the palette is
 * drifting, and the atlas disables itself rather than keep paying.
 */
export const CHURN_WINDOW_CELLS = 8192;
export const CHURN_NEW_STYLES_LIMIT = 32;
/** How long a disabled atlas stays out before it re-tests the screen. */
export const CHURN_COOLDOWN_CELLS = 300_000;
/**
 * Slack around the cell so a descender or an overhanging glyph is not clipped,
 * in CSS pixels. The vendor draws all backgrounds before any text, so text
 * spilling into a neighbour's box is intended, and the slack is transparent
 * everywhere else. Ceiled onto the device grid before it is used — see
 * `slotGeometry`.
 */
export const GLYPH_PADDING_PX = 3;

/**
 * Vertical sub-pixel positions a glyph may be rasterised at.
 *
 * A blit is only sharp when source and destination are both whole device pixels,
 * but the row grid is not: a cell 21 CSS px tall at ratio 1.25 steps 26.25 device
 * pixels, so row 1 wants its baseline a quarter of a pixel below the whole-pixel
 * grid. Rather than round that away, the glyph is rasterised once per phase and
 * the row picks the variant whose ink already carries its offset — the position is
 * kept, the resampling is not.
 *
 * Four is the ceiling because a step of `n + k/4` has exactly four phases, which
 * covers ratios 1, 1.25, 1.5, 1.75 and 2. Phases are only ever EXACT: a step whose
 * denominator is larger has no faithful phase set within the bound, and the atlas
 * stands down for that signature rather than quantize into the nearest quarter.
 * Approximating is a position error the cache would hold forever and no
 * measurement would reliably catch — a 110% zoom happened to land on zero
 * differing pixels while 130% did not, from the same rounding.
 */
export const MAX_SUBPIXEL_PHASES = 4;

/** Slack for binary fractions that do not land exactly (`8.8 * 1.25` is not 11). */
const GRID_EPSILON = 1e-6;

function isOnDeviceGrid(devicePx: number): boolean {
	return Math.abs(devicePx - Math.round(devicePx)) < GRID_EPSILON;
}

/**
 * How many distinct sub-pixel positions a grid of this step actually visits, or
 * ZERO when no exact answer fits within `MAX_SUBPIXEL_PHASES`.
 *
 * `frac(n * step)` repeats with the denominator of `step`'s fractional part, so a
 * step of 26.25 visits four positions and 31.5 visits two — allocating four rows
 * for the latter would double the strip for two phases nobody asks for. A step
 * that is not a quarter (a browser zoom of 1.1 or 1.3) needs a denominator of ten,
 * which is unbounded memory to hold and a silent position error to skip; zero is
 * the caller's signal to leave those cells to the vendor.
 */
export function subpixelPhaseCount(stepDevicePx: number): number {
	if (!Number.isFinite(stepDevicePx)) return 0;
	for (let phases = 1; phases <= MAX_SUBPIXEL_PHASES; phases++) {
		if (isOnDeviceGrid(stepDevicePx * phases)) return phases;
	}
	return 0;
}

/**
 * Marks the hidden host that strip canvases live in. Attribute rather than an
 * id so a duplicate can never silently take the name over.
 */
export const ATLAS_HOST_ATTR = "data-dev3-glyph-atlas";

/**
 * Strip canvases must be IN the document, or WebKit rasterises them with the
 * wrong smoothing.
 *
 * A detached canvas has no computed style, so it never sees the app's global
 * `-webkit-font-smoothing: antialiased` and falls back to the platform default.
 * Measured in a real WKWebView at JetBrains Mono 16: a detached strip carries
 * ~31% more ink per glyph than the attached terminal canvas beside it, which is
 * exactly the "terminal text looks bolder than Ghostty" of issue #1786. An
 * inline `style.webkitFontSmoothing` on a detached canvas changes nothing —
 * measured byte-identical to no rule at all.
 *
 * `display: none` is enough: it still resolves style, so the strips match the
 * visible canvas byte for byte, while costing no layout box, no paint and no
 * accessibility node.
 */
let atlasHost: HTMLElement | null = null;

function atlasHostElement(): HTMLElement | null {
	if (typeof document === "undefined" || !document.body) return null;
	if (atlasHost?.isConnected) return atlasHost;
	const host = document.createElement("div");
	host.setAttribute(ATLAS_HOST_ATTR, "");
	host.setAttribute("aria-hidden", "true");
	host.style.display = "none";
	document.body.appendChild(host);
	atlasHost = host;
	return host;
}

/** True for something the DOM will actually accept as a child. */
function isDomNode(value: unknown): value is Node {
	return typeof Node !== "undefined" && value instanceof Node;
}

function attachPage(canvas: HTMLCanvasElement): void {
	if (isDomNode(canvas)) atlasHostElement()?.appendChild(canvas);
}

/** Drop a strip, and the host with it once nothing is left parked there. */
function detachPage(canvas: HTMLCanvasElement): void {
	if (isDomNode(canvas)) canvas.parentNode?.removeChild(canvas);
	if (atlasHost && atlasHost.childNodes.length === 0) {
		atlasHost.parentNode?.removeChild(atlasHost);
		atlasHost = null;
	}
}

/** The 2D-context surface this module needs; narrowed so tests can fake it. */
interface AtlasContext {
	font: string;
	fillStyle: string | CanvasGradient | CanvasPattern;
	textBaseline: CanvasTextBaseline;
	textAlign: CanvasTextAlign;
	fillText(text: string, x: number, y: number): void;
	drawImage(
		image: CanvasImageSource,
		sx: number, sy: number, sw: number, sh: number,
		dx: number, dy: number, dw: number, dh: number,
	): void;
	clearRect(x: number, y: number, w: number, h: number): void;
	scale(x: number, y: number): void;
}

/** A hovered link's span, in viewport cells, as the vendor was told it. */
export interface HoveredLinkRange {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
}

/** The vendor renderer's shape, as far as this module touches it. */
export interface AtlasRenderer {
	renderCellText(cell: GhosttyCell, col: number, row: number): void;
	isInSelection?(col: number, row: number): boolean;
	/** OSC 8 hyperlink under the pointer, 0 when none. */
	hoveredHyperlinkId?: number;
	/** Span a link provider resolved under the pointer, null when none. */
	hoveredLinkRange?: HoveredLinkRange | null;
	metrics?: { width: number; height: number; baseline: number };
	fontSize?: number;
	fontFamily?: string;
	devicePixelRatio?: number;
	ctx?: unknown;
}

export interface AtlasStats {
	/** Cells drawn from the atlas. */
	hits: number;
	/** Cells handed back to the vendor. */
	misses: number;
	/** Glyphs rasterised (each one costs a `fillText`, once). */
	rasterised: number;
	styles: number;
	pages: number;
	/** Bytes of backing store across every strip canvas, at 4 bytes per device pixel. */
	pageBytes: number;
	/** True while the churn detector has the atlas switched off. */
	disabled: boolean;
	/** How many times the detector has fired since installation. */
	disableCount: number;
}

interface Page {
	canvas: HTMLCanvasElement;
	ctx: AtlasContext;
	/** Glyph key → slot index within this page. */
	slots: Map<number, number>;
	used: number;
}

interface Style {
	pages: Page[];
	/** Glyph key → the page holding it, for an O(1) second hit. */
	index: Map<number, { page: Page; slot: number }>;
}

/** Font metrics and device ratio the cached bitmaps were rasterised for. */
interface Signature {
	fontSize: number;
	fontFamily: string;
	dpr: number;
	cellWidth: number;
	cellHeight: number;
	baseline: number;
}

function signatureOf(renderer: AtlasRenderer): Signature | null {
	const metrics = renderer.metrics;
	if (!metrics || !(metrics.width > 0) || !(metrics.height > 0)) return null;
	return {
		fontSize: renderer.fontSize ?? 0,
		fontFamily: renderer.fontFamily ?? "monospace",
		dpr: renderer.devicePixelRatio && renderer.devicePixelRatio > 0 ? renderer.devicePixelRatio : 1,
		cellWidth: metrics.width,
		cellHeight: metrics.height,
		baseline: metrics.baseline,
	};
}

/**
 * Whether the cached bitmaps still match the renderer, WITHOUT building a
 * Signature to compare against. This runs once per cell — allocating an object
 * here cost 9200 short-lived objects a frame, which measured as most of the
 * overhead the atlas added on a screen it could not cache.
 */
function signatureMatches(sig: Signature, renderer: AtlasRenderer): boolean {
	const metrics = renderer.metrics;
	if (!metrics) return false;
	const dpr = renderer.devicePixelRatio && renderer.devicePixelRatio > 0 ? renderer.devicePixelRatio : 1;
	return sig.cellWidth === metrics.width && sig.cellHeight === metrics.height
		&& sig.baseline === metrics.baseline && sig.dpr === dpr
		&& sig.fontSize === (renderer.fontSize ?? 0)
		&& sig.fontFamily === (renderer.fontFamily ?? "monospace");
}

/**
 * The strip's layout, in WHOLE DEVICE PIXELS.
 *
 * Every number the atlas hands to `drawImage` comes from here, and every one of
 * them is an integer. The slot used to be sized in CSS pixels and multiplied by the
 * ratio at blit time, so at ratio 1.25 a 3 px pad became 3.75 device pixels and
 * both the source rect and its destination landed mid-pixel. The blit then resampled an already-antialiased bitmap — a
 * second round of averaging over a glyph that had none to spare, which reads as
 * the whole terminal being slightly out of focus.
 */
interface SlotGeometry {
	/** Horizontal slack, whole device px. */
	padX: number;
	/** Vertical slack, whole device px. */
	padY: number;
	/** Slot stride across the strip, whole device px. */
	slotW: number;
	/** Slot stride down the strip — one row per phase, whole device px. */
	slotH: number;
	/**
	 * The same slot, back in the CSS pixels the vendor's transform expects.
	 * Precomputed because it is constant per signature and `drawImage` runs once per
	 * cell; the round trip through the ratio can land a few femtopixels off a whole
	 * device pixel, which is orders of magnitude below the rasteriser's own
	 * quantisation and identical for every cell, so nothing shimmers.
	 */
	slotWCss: number;
	slotHCss: number;
	/**
	 * Rasterised sub-pixel variants; 1 whenever the row grid is already whole, and
	 * 0 when this row grid has no exact phase set the atlas may hold — the signal
	 * to leave the signature to the vendor entirely.
	 */
	phases: number;
	/** Column stride in device px, and whether it is a whole number of them. */
	cellWDev: number;
	cellWOnGrid: boolean;
	/** Row stride in device px. Fractional is normal and is what `phases` answers. */
	cellHDev: number;
}

export function slotGeometry(sig: Signature): SlotGeometry {
	const { dpr } = sig;
	// Ceiled, not rounded: the pad is slack against clipping, and rounding 3 × 1.25
	// down to 3 would spend the fix on a re-clipped descender.
	const padX = Math.ceil(GLYPH_PADDING_PX * dpr - GRID_EPSILON);
	const padY = Math.ceil(GLYPH_PADDING_PX * dpr - GRID_EPSILON);
	const cellWDev = sig.cellWidth * dpr;
	const cellHDev = sig.cellHeight * dpr;
	const slotW = Math.ceil(cellWDev - GRID_EPSILON) + padX * 2;
	const slotH = Math.ceil(cellHDev - GRID_EPSILON) + padY * 2;
	return {
		padX, padY, slotW, slotH,
		slotWCss: slotW / dpr,
		slotHCss: slotH / dpr,
		phases: subpixelPhaseCount(cellHDev),
		cellWDev,
		cellWOnGrid: isOnDeviceGrid(cellWDev),
		cellHDev,
	};
}

/**
 * Where row `row` puts its slot, and which phase carries the rest of the offset.
 *
 * `top` is the whole device pixel the slot's own top-left lands on; `phase`
 * indexes the variant whose ink is already pushed down by the remainder. Their sum
 * reproduces the position the vendor's `fillText` would have used exactly —
 * `phases` is only ever the step's true denominator, never an approximation.
 *
 * Packed into one number — `top * MAX_SUBPIXEL_PHASES + phase` — so the hot path
 * never allocates, whatever order rows arrive in. `phase` is always below the cap
 * and rows are non-negative, so nothing is lost.
 */
export function packRowPlacement(row: number, geom: SlotGeometry): number {
	const ideal = row * geom.cellHDev;
	if (geom.phases === 1) return Math.round(ideal) * MAX_SUBPIXEL_PHASES;
	let top = Math.floor(ideal + GRID_EPSILON);
	let phase = Math.round((ideal - top) * geom.phases);
	// The remainder rounded up to a whole pixel: that IS the next pixel, phase zero.
	if (phase >= geom.phases) { top += 1; phase = 0; }
	return top * MAX_SUBPIXEL_PHASES + phase;
}

export const packedTop = (packed: number): number => Math.floor(packed / MAX_SUBPIXEL_PHASES);
export const packedPhase = (packed: number): number => packed - packedTop(packed) * MAX_SUBPIXEL_PHASES;

/** Readable form of the same placement. For tests and callers off the hot path. */
export function rowPlacement(row: number, geom: SlotGeometry): { top: number; phase: number } {
	const packed = packRowPlacement(row, geom);
	return { top: packedTop(packed), phase: packedPhase(packed) };
}

/** Where column `col` puts its slot, in whole device pixels. */
export function columnLeft(col: number, geom: SlotGeometry): number {
	// Integer multiply when the cell is on the grid — `deviceGridWidth` in
	// `terminal-cell-metrics` puts it there — so no error accumulates across a row.
	return geom.cellWOnGrid ? col * Math.round(geom.cellWDev) : Math.round(col * geom.cellWDev);
}

/**
 * One glyph identity: the codepoint plus the two style bits that change its
 * shape. Colour is NOT in here — it selects the atlas, not the slot.
 */
function glyphKey(codepoint: number, bold: boolean, italic: boolean): number {
	return (codepoint << 2) | (bold ? 1 : 0) | (italic ? 2 : 0);
}

/** Atlas identity: the ink colour, plus the bits that alter the raster. */
function styleKey(r: number, g: number, b: number, bold: boolean, italic: boolean): number {
	return (((r << 16) | (g << 8) | b) << 2) | (bold ? 1 : 0) | (italic ? 2 : 0);
}

/**
 * A codepoint the fast path may cache.
 *
 * Space and NUL draw nothing — the vendor's `fillText(" ")` puts no ink on the
 * canvas — so they are skipped outright rather than cached. Everything above the
 * BMP is left to the vendor: a surrogate pair is not one `fromCodePoint` glyph
 * for shaping purposes, and it is rare enough not to be worth the risk.
 */
export function isCacheableCodepoint(codepoint: number): boolean {
	return codepoint > 0x20 && codepoint <= 0xffff && codepoint !== 0x7f;
}

/** Nothing to draw at all: an empty cell costs neither a blit nor a fillText. */
export function isBlankCodepoint(codepoint: number): boolean {
	return codepoint === 0 || codepoint === 0x20;
}

/**
 * Whether the vendor would underline this cell because a link is hovered.
 *
 * `renderCellText` paints two decorations that are NOT cell flags: the OSC 8
 * hyperlink the pointer is on, and the span a link provider resolved (dev3
 * registers one for file paths). A cached blit carries neither, so a hovered link
 * would silently lose its underline — these cells go to the vendor. The span test
 * matches the vendor's own, so only the hovered cells defer, and a blank cell
 * inside the span defers too: the vendor underlines it.
 */
export function isHoverDecorated(
	renderer: AtlasRenderer, cell: GhosttyCell, col: number, row: number,
): boolean {
	const hovered = renderer.hoveredHyperlinkId ?? 0;
	if (hovered > 0 && cell.hyperlink_id === hovered) return true;
	const range = renderer.hoveredLinkRange;
	if (!range) return false;
	if (row < range.startY || row > range.endY) return false;
	if (row === range.startY && col < range.startX) return false;
	if (row === range.endY && col > range.endX) return false;
	return true;
}

export interface GlyphAtlasOptions {
	/** Injected so tests can supply a recording canvas. */
	createCanvas?: () => HTMLCanvasElement;
	/** Overrides `MAX_STYLES`; benchmarks sweep it, production takes the default. */
	maxStyles?: number;
	/** Set false to measure the atlas without the churn detector. */
	churnDetection?: boolean;
}

export interface GlyphAtlas {
	/**
	 * Draw one cell, or report that it must go to the vendor.
	 * Returns true when the atlas handled it (including "nothing to draw").
	 */
	draw(renderer: AtlasRenderer, ctx: AtlasContext, cell: GhosttyCell, col: number, row: number): boolean;
	stats(): AtlasStats;
	/** Drop every bitmap — a font, zoom or DPI change invalidates all of them. */
	reset(): void;
}

export function createGlyphAtlas(opts: GlyphAtlasOptions = {}): GlyphAtlas {
	const createCanvas = opts.createCanvas ?? (() => document.createElement("canvas"));
	const maxStyles = opts.maxStyles ?? MAX_STYLES;
	const churnDetection = opts.churnDetection ?? true;
	const styles = new Map<number, Style>();
	let signature: Signature | null = null;
	// Derived once per signature: recomputing it per cell would allocate 9200
	// objects a frame, which is the cost the signature fast path exists to avoid.
	let geometry: SlotGeometry | null = null;
	// Row placement is identical for every cell in a row, so one scalar cache turns
	// a row's 200 computations into one. Scalars, not an object: same reason the
	// signature is compared field-by-field rather than rebuilt.
	let placedRow = -1;
	let placedTop = 0;
	let placedPhase = 0;
	let hits = 0;
	let misses = 0;
	let rasterised = 0;
	let pageCount = 0;
	let pageBytes = 0;
	// Churn state. `windowCells` counts every cell the fast path considered;
	// `windowNewStyles` counts how many of them minted a style nobody had asked for.
	let windowCells = 0;
	let windowNewStyles = 0;
	let warmingUp = true;
	let disabled = false;
	let disableCount = 0;
	let cooldownCells = 0;

	function newPage(sig: Signature, geom: SlotGeometry): Page | null {
		const canvas = createCanvas();
		// Whole device pixels, so every slot boundary is one too. A strip carries one
		// ROW per sub-pixel phase; at a whole-pixel row grid there is exactly one.
		canvas.width = geom.slotW * GLYPHS_PER_PAGE;
		canvas.height = geom.slotH * geom.phases;
		// Before the first fillText, so the glyphs are rasterised with the page's
		// own font smoothing rather than the platform default — see `atlasHost`.
		attachPage(canvas);
		// Alpha is REQUIRED: the strip is transparent between glyphs, and an opaque
		// atlas would blit black boxes over the cell backgrounds.
		const ctx = canvas.getContext("2d") as AtlasContext | null;
		if (!ctx) { detachPage(canvas); return null; }
		// The page is addressed in device pixels but drawn through the same CSS-pixel
		// transform the vendor's own canvas has, so the rasteriser sees an identical
		// font matrix and produces identical ink.
		ctx.scale(sig.dpr, sig.dpr);
		ctx.textBaseline = "alphabetic";
		ctx.textAlign = "left";
		pageCount += 1;
		pageBytes += canvas.width * canvas.height * 4;
		return { canvas, ctx, slots: new Map(), used: 0 };
	}

	function rasterise(
		style: Style, sig: Signature, geom: SlotGeometry, key: number, text: string,
		colour: string, bold: boolean, italic: boolean,
	): { page: Page; slot: number } | null {
		let page = style.pages[style.pages.length - 1];
		if (!page || page.used >= GLYPHS_PER_PAGE) {
			if (style.pages.length >= MAX_PAGES_PER_STYLE) return null;
			const fresh = newPage(sig, geom);
			if (!fresh) return null;
			style.pages.push(fresh);
			page = fresh;
		}
		const slot = page.used;
		let font = "";
		if (italic) font += "italic ";
		if (bold) font += "bold ";
		page.ctx.font = `${font}${sig.fontSize}px ${sig.fontFamily}`;
		page.ctx.fillStyle = colour;
		const penX = slot * geom.slotW + geom.padX;
		for (let phase = 0; phase < geom.phases; phase++) {
			// The pen sits at the cell's own baseline, offset by the pad and by this
			// phase's fraction of a device pixel. Blitting the slot at
			// (columnLeft - padX, rowTop - padY) then lands the ink where the vendor's
			// own fillText would have put it — the fraction survives in the raster
			// instead of being resampled into it.
			const penY = phase * geom.slotH + geom.padY + phase / geom.phases + sig.baseline * sig.dpr;
			if (!drawNativeTerminalText(page.ctx as CanvasRenderingContext2D, text, penX / sig.dpr, penY / sig.dpr, sig.dpr)) {
				page.ctx.fillText(text, penX / sig.dpr, penY / sig.dpr);
			}
		}
		page.used += 1;
		page.slots.set(key, slot);
		const placed = { page, slot };
		style.index.set(key, placed);
		rasterised += 1;
		return placed;
	}

	function reset(): void {
		// Zeroing the size frees a canvas's backing store immediately; dropping the
		// reference alone leaves tens of megabytes to the collector's discretion.
		for (const style of styles.values()) {
			for (const page of style.pages) {
				page.canvas.width = 0;
				page.canvas.height = 0;
				detachPage(page.canvas);
			}
		}
		styles.clear();
		placedRow = -1;
		pageCount = 0;
		pageBytes = 0;
		windowCells = 0;
		windowNewStyles = 0;
		warmingUp = true;
	}

	/**
	 * Close out a churn window. Returns true when the palette is drifting badly
	 * enough that the atlas should stop.
	 *
	 * The first window after a reset is the honest warm-up — a fresh screen mints
	 * a style per colour and that is the price of admission, not churn.
	 */
	function closeWindow(): boolean {
		const drifting = !warmingUp && windowNewStyles > CHURN_NEW_STYLES_LIMIT;
		warmingUp = false;
		windowCells = 0;
		windowNewStyles = 0;
		return drifting;
	}

	return {
		draw(renderer, ctx, cell, col, row) {
			// Ordered by cost: a bitwise test on the cell, then this module's own
			// maps, and only then anything that calls back into the vendor. A cell
			// the atlas cannot take must pay as little as possible on the way out —
			// that is what keeps an uncacheable screen from getting slower.
			// Switched off by the churn detector: the cheapest possible refusal, and
			// a countdown so a screen that later settles gets another chance.
			if (disabled) {
				misses += 1;
				if (--cooldownCells <= 0) { disabled = false; warmingUp = true; }
				return false;
			}

			const flags = cell.flags ?? 0;
			if (flags & DEFERRED_FLAGS) { misses += 1; return false; }
			if (cell.width !== 1) { misses += 1; return false; }
			if ((cell.grapheme_len ?? 0) > 0) { misses += 1; return false; }
			// Two property reads, and both are null/0 unless the pointer is on a link.
			// Ahead of the blank shortcut: the vendor underlines spaces in the span too.
			if (isHoverDecorated(renderer, cell, col, row)) { misses += 1; return false; }

			const codepoint = cell.codepoint ?? 0;
			// A blank cell is genuinely nothing to paint — claim it, draw nothing.
			if (isBlankCodepoint(codepoint)) { hits += 1; return true; }
			if (!isCacheableCodepoint(codepoint)) { misses += 1; return false; }
			// A powerline cap or block glyph is stretched onto the cell box downstream;
			// a flat cached raster would put the hairline seam back.
			if (isCellFittedGlyph(codepoint)) { misses += 1; return false; }

			if (!signature || !geometry || !signatureMatches(signature, renderer)) {
				// Zoom, theme font or a move to another display: every bitmap was
				// rasterised for the old metrics and would blit at the wrong size.
				const fresh = signatureOf(renderer);
				if (!fresh) { misses += 1; return false; }
				reset();
				signature = fresh;
				geometry = slotGeometry(fresh);
			}
			const sig = signature;
			const geom = geometry;
			// No exact phase set for this row grid: approximating it would bake a
			// permanent position error into every cached glyph, so the signature goes
			// to the vendor whole. One integer test per cell.
			if (geom.phases === 0) { misses += 1; return false; }

			const bold = (flags & FLAG_BOLD) !== 0;
			const italic = (flags & FLAG_ITALIC) !== 0;
			const r = cell.fg_r ?? 0, g = cell.fg_g ?? 0, b = cell.fg_b ?? 0;

			// Only cells that reach the style lookup count towards a churn window:
			// blanks and deferred glyphs say nothing about whether the palette moves.
			if (churnDetection && ++windowCells >= CHURN_WINDOW_CELLS && closeWindow()) {
				disabled = true;
				disableCount += 1;
				cooldownCells = CHURN_COOLDOWN_CELLS;
				reset();
				misses += 1;
				return false;
			}

			const sKey = styleKey(r, g, b, bold, italic);
			let style = styles.get(sKey);
			if (!style) {
				// Counted BEFORE the cap check: once the cap is full a drifting palette
				// stops minting styles and would look perfectly settled to the detector.
				// What churn actually is, is asking for a colour nobody has seen.
				windowNewStyles += 1;
				// Full: bail before the selection probe below, so a truecolour flood
				// costs one map lookup per cell rather than a call into the renderer.
				if (styles.size >= maxStyles) { misses += 1; return false; }
				style = { pages: [], index: new Map() };
				styles.set(sKey, style);
			}

			// Selection recolours the glyph; let the vendor own that path rather than
			// keep a second colour rule in step with it. Last, because it is the only
			// check that calls back into the renderer.
			if (renderer.isInSelection?.(col, row)) { misses += 1; return false; }

			const gKey = glyphKey(codepoint, bold, italic);
			const placed = style.index.get(gKey)
				?? rasterise(style, sig, geom, gKey, String.fromCodePoint(codepoint), `rgb(${r},${g},${b})`, bold, italic);
			if (!placed) { misses += 1; return false; }

			if (row !== placedRow) {
				const packed = packRowPlacement(row, geom);
				placedRow = row;
				placedTop = packedTop(packed);
				placedPhase = packedPhase(packed);
			}
			// Source and destination are the same whole number of device pixels, at
			// whole device-pixel origins: `drawImage` copies, it does not resample. The
			// destination is divided back out because the vendor's context carries the
			// ratio in its transform.
			ctx.drawImage(
				placed.page.canvas,
				placed.slot * geom.slotW, placedPhase * geom.slotH, geom.slotW, geom.slotH,
				(columnLeft(col, geom) - geom.padX) / sig.dpr, (placedTop - geom.padY) / sig.dpr,
				geom.slotWCss, geom.slotHCss,
			);
			hits += 1;
			return true;
		},
		stats() {
			return { hits, misses, rasterised, styles: styles.size, pages: pageCount, pageBytes, disabled, disableCount };
		},
		reset,
	};
}

// ── Installation ───────────────────────────────────────────────────
// Wraps `renderCellText`, not `render`: the bidi proxy already owns `render`
// (see terminal-bidi/proxy.ts), and hooking a different method keeps the two
// independent instead of ordering-dependent.

const ORIGINAL_CELL_TEXT = Symbol.for("dev3.glyphAtlas.originalRenderCellText");
const ATLAS = Symbol.for("dev3.glyphAtlas.instance");

type PatchedRenderer = AtlasRenderer & {
	[ORIGINAL_CELL_TEXT]?: AtlasRenderer["renderCellText"];
	[ATLAS]?: GlyphAtlas;
};

export interface GlyphAtlasHandle {
	/** Restore whatever this wrapped. Safe to call twice. */
	dispose(): void;
	stats(): AtlasStats | null;
}

/**
 * Idempotent: installing twice returns a handle over the existing atlas rather
 * than stacking a second wrapper.
 */
export function installGlyphAtlas(renderer: AtlasRenderer, opts: GlyphAtlasOptions = {}): GlyphAtlasHandle {
	const target = renderer as PatchedRenderer;
	if (!target[ORIGINAL_CELL_TEXT] && typeof renderer.renderCellText === "function") {
		const original = renderer.renderCellText;
		const atlas = createGlyphAtlas(opts);
		target[ORIGINAL_CELL_TEXT] = original;
		target[ATLAS] = atlas;

		target.renderCellText = function atlasRenderCellText(cell, col, row) {
			const self = this as AtlasRenderer;
			const ctx = self.ctx as AtlasContext | undefined;
			if (ctx && atlas.draw(self, ctx, cell, col, row)) return;
			original.call(self, cell, col, row);
		};
	}

	return {
		dispose() { uninstallGlyphAtlas(renderer); },
		stats() { return glyphAtlasStats(renderer); },
	};
}

/** Restore the vendor's own method. Safe when nothing is installed. */
export function uninstallGlyphAtlas(renderer: AtlasRenderer): void {
	const target = renderer as PatchedRenderer;
	const original = target[ORIGINAL_CELL_TEXT];
	if (!original) return;
	target.renderCellText = original;
	// Same reason `reset` zeroes the canvases rather than dropping them: tens of
	// megabytes of strip canvas would otherwise wait on the collector, and a pane
	// teardown or a font change is exactly when that memory is wanted back.
	target[ATLAS]?.reset();
	delete target[ORIGINAL_CELL_TEXT];
	delete target[ATLAS];
}

export function isGlyphAtlasInstalled(renderer: AtlasRenderer): boolean {
	return (renderer as PatchedRenderer)[ORIGINAL_CELL_TEXT] !== undefined;
}

/** Cache counters for the Debug overlay, or null when nothing is installed. */
export function glyphAtlasStats(renderer: AtlasRenderer): AtlasStats | null {
	return (renderer as PatchedRenderer)[ATLAS]?.stats() ?? null;
}
