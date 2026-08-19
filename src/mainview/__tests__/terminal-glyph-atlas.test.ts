/**
 * The glyph atlas, driven through ghostty-web's REAL CanvasRenderer.
 *
 * What matters here is not speed — a happy-dom canvas draws nothing — but that
 * the fast path is exactly as narrow as claimed. Every cell the atlas takes over
 * stops being a `fillText`, and every cell it must not touch has to still reach
 * the vendor: an atlas that swallowed a selected cell, an underlined one, or a
 * powerline cap would silently paint the wrong pixels, and no perf number would
 * ever show it.
 */
import { CanvasRenderer, type GhosttyCell } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGlyphAtlas,
	installGlyphAtlas,
	uninstallGlyphAtlas,
	isGlyphAtlasInstalled,
	glyphAtlasStats,
	isBlankCodepoint,
	isCacheableCodepoint,
	GLYPHS_PER_PAGE,
	MAX_PAGES_PER_STYLE,
	MAX_STYLES,
	CHURN_WINDOW_CELLS,
	CHURN_COOLDOWN_CELLS,
	type AtlasRenderer,
} from "../terminal-glyph-atlas";
import { blank, cell, graphemeCell, recordingCtx, type RecordedOp } from "../terminal-bidi/__tests__/fixtures";

let ops: RecordedOp[];
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	const recorder = recordingCtx();
	ops = recorder.ops;
	// happy-dom returns null from getContext, and the atlas builds its own strip
	// canvases, so the stub has to live on the prototype for both.
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockImplementation(() => recorder.ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
	getContextSpy.mockRestore();
});

function newRenderer(): CanvasRenderer {
	return new CanvasRenderer(document.createElement("canvas"), {
		fontSize: 15,
		fontFamily: "monospace",
		cursorBlink: false,
		devicePixelRatio: 1,
	});
}

/** Paint one cell through whatever wrappers are installed. */
function paint(renderer: CanvasRenderer, c: GhosttyCell, col = 0, row = 0): void {
	(renderer as unknown as AtlasRenderer).renderCellText(c, col, row);
	}

const count = (op: string) => ops.filter((o) => o.op === op).length;

describe("install / uninstall", () => {
	it("wraps and restores the vendor's own method", () => {
		const renderer = newRenderer();
		const before = (renderer as unknown as AtlasRenderer).renderCellText;

		const handle = installGlyphAtlas(renderer as unknown as AtlasRenderer);
		expect(isGlyphAtlasInstalled(renderer as unknown as AtlasRenderer)).toBe(true);
		expect((renderer as unknown as AtlasRenderer).renderCellText).not.toBe(before);

		handle.dispose();
		expect(isGlyphAtlasInstalled(renderer as unknown as AtlasRenderer)).toBe(false);
		expect((renderer as unknown as AtlasRenderer).renderCellText).toBe(before);
	});

	it("does not stack a second wrapper when installed twice", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);
		const first = (renderer as unknown as AtlasRenderer).renderCellText;

		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		expect((renderer as unknown as AtlasRenderer).renderCellText).toBe(first);
		// One dispose is enough — a stacked wrapper would survive it.
		uninstallGlyphAtlas(renderer as unknown as AtlasRenderer);
		expect(isGlyphAtlasInstalled(renderer as unknown as AtlasRenderer)).toBe(false);
	});

	it("survives being disposed twice, and reports no stats when absent", () => {
		const renderer = newRenderer();
		const handle = installGlyphAtlas(renderer as unknown as AtlasRenderer);
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toBeNull();
	});
});

describe("the fast path replaces the per-cell fillText", () => {
	it("blits an ordinary glyph instead of shaping it", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		paint(renderer, cell("A"));
		// The FIRST occurrence rasterises once into the strip, then blits.
		expect(count("drawImage")).toBe(1);
		const rasterisingFills = count("fillText");
		expect(rasterisingFills).toBe(1);

		ops.length = 0;
		for (let i = 0; i < 50; i++) paint(renderer, cell("A"), i);

		// Every repeat is a pure blit: 50 more glyphs, zero more shaping.
		expect(count("drawImage")).toBe(50);
		expect(count("fillText")).toBe(0);
		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ hits: 51, misses: 0 });
	});

	it("rasterises one slot per glyph but reuses the strip", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		for (const ch of "abcabc") paint(renderer, cell(ch));

		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({
			rasterised: 3, hits: 6, misses: 0, styles: 1, pages: 1,
		});
	});

	it("keeps one atlas per colour, so the same letter in two colours is two slots", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		paint(renderer, cell("x", { fg_r: 255, fg_g: 0, fg_b: 0 }));
		paint(renderer, cell("x", { fg_r: 0, fg_g: 255, fg_b: 0 }));

		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ styles: 2, rasterised: 2 });
	});

	it("treats bold and italic as different glyphs, not just different fonts", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		paint(renderer, cell("g"));
		paint(renderer, cell("g", { flags: 1 }));   // BOLD
		paint(renderer, cell("g", { flags: 2 }));   // ITALIC

		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ rasterised: 3, misses: 0 });
	});

	it("draws nothing at all for a blank cell", () => {
		const renderer = newRenderer();
		installGlyphAtlas(renderer as unknown as AtlasRenderer);

		paint(renderer, cell("", { codepoint: 0 }));
		paint(renderer, cell(" "));

		expect(count("drawImage")).toBe(0);
		expect(count("fillText")).toBe(0);
		expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ hits: 2, rasterised: 0 });
	});
});

describe("what the atlas must NOT take over", () => {
	// Each of these would be drawn WRONG by a flat cached raster, so each one has
	// to reach the vendor. A regression here is invisible in any timing number.
	const DEFERRED: Array<[string, GhosttyCell]> = [
		["underline", cell("a", { flags: 4 })],
		["strikethrough", cell("a", { flags: 8 })],
		["inverse video", cell("a", { flags: 16 })],
		["invisible", cell("a", { flags: 32 })],
		["faint", cell("a", { flags: 128 })],
		["a wide (CJK) cell", cell("漢", { width: 2 })],
		["the spacer after a wide cell", cell("", { codepoint: 0, width: 0 })],
		["a grapheme cluster", graphemeCell("é")],
		["a powerline cap", cell(String.fromCodePoint(0xe0b0))],
		["a full block", cell(String.fromCodePoint(0x2588))],
		["a box-drawing corner", cell(String.fromCodePoint(0x250c))],
		["an astral-plane codepoint", cell("𝔘")],
	];

	for (const [name, c] of DEFERRED) {
		it(`hands ${name} back to the vendor`, () => {
			const renderer = newRenderer();
			installGlyphAtlas(renderer as unknown as AtlasRenderer);

			paint(renderer, c);

			expect(count("drawImage")).toBe(0);
			const stats = glyphAtlasStats(renderer as unknown as AtlasRenderer);
			// width:0 is skipped by renderLine upstream, so it only has to not be cached.
			expect(stats?.hits).toBe(0);
			expect(stats?.misses).toBe(1);
		});
	}

	it("hands a selected cell back, because selection recolours the glyph", () => {
		const renderer = newRenderer();
		const target = renderer as unknown as AtlasRenderer & { isInSelection?: (c: number, r: number) => boolean };
		target.isInSelection = (col: number) => col === 3;
		installGlyphAtlas(target);

		paint(renderer, cell("a"), 2);
		paint(renderer, cell("a"), 3);

		expect(glyphAtlasStats(target)).toMatchObject({ hits: 1, misses: 1 });
	});

	// The vendor underlines a hovered link INSIDE renderCellText, off state that is
	// not a cell flag — so these are the two decorations a cached blit would drop
	// with nothing in the cell to warn about it. Driven through the real renderer's
	// own setters, so the state is wired exactly the way a real hover wires it.
	describe("a hovered link keeps its underline", () => {
		it("hands back the cell whose OSC 8 hyperlink is the hovered one", () => {
			const renderer = newRenderer();
			renderer.setHoveredHyperlinkId(7);
			installGlyphAtlas(renderer as unknown as AtlasRenderer);

			paint(renderer, cell("a", { hyperlink_id: 7 }));
			expect(count("drawImage")).toBe(0);

			ops.length = 0;
			// A different link, and an unlinked cell, are still cached.
			paint(renderer, cell("a", { hyperlink_id: 9 }), 1);
			paint(renderer, cell("a"), 2);
			expect(count("drawImage")).toBe(2);
			expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ hits: 2, misses: 1 });
		});

		it("hands back every cell inside the hovered span, and only those", () => {
			const renderer = newRenderer();
			renderer.setHoveredLinkRange({ startX: 2, startY: 1, endX: 4, endY: 3 });
			installGlyphAtlas(renderer as unknown as AtlasRenderer);

			// Same span test the vendor makes: the first row starts at startX, the last
			// row ends at endX, and every row between is covered end to end.
			const inside: Array<[number, number]> = [[2, 1], [9, 1], [0, 2], [9, 2], [0, 3], [4, 3]];
			const outside: Array<[number, number]> = [[1, 1], [5, 3], [3, 0], [3, 4]];
			for (const [col, row] of inside) paint(renderer, cell("a"), col, row);
			for (const [col, row] of outside) paint(renderer, cell("a"), col, row);

			expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({
				hits: outside.length,
				misses: inside.length,
			});
		});

		it("defers a BLANK cell in the span, which the vendor underlines too", () => {
			const renderer = newRenderer();
			renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 8, endY: 0 });
			installGlyphAtlas(renderer as unknown as AtlasRenderer);

			paint(renderer, blank(), 4, 0);

			// Claiming it as a free "nothing to draw" hit would eat the underline: the
			// vendor has to be reached, and reaching it is what a fillText proves.
			expect(count("fillText")).toBe(1);
			expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ hits: 0, misses: 1 });
		});

		it("goes back to caching once the pointer leaves the link", () => {
			const renderer = newRenderer();
			renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 8, endY: 0 });
			installGlyphAtlas(renderer as unknown as AtlasRenderer);
			paint(renderer, cell("a"), 1, 0);

			renderer.setHoveredLinkRange(null);
			ops.length = 0;
			paint(renderer, cell("a"), 1, 0);

			expect(count("drawImage")).toBe(1);
			expect(glyphAtlasStats(renderer as unknown as AtlasRenderer)).toMatchObject({ hits: 1, misses: 1 });
		});
	});
});

describe("dispose", () => {
	it("gives the strip canvases' backing store back instead of leaving it to the GC", () => {
		const renderer = newRenderer();
		const handle = installGlyphAtlas(renderer as unknown as AtlasRenderer);
		const created: HTMLCanvasElement[] = [];
		const create = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			const el = Object.getPrototypeOf(document).createElement.call(document, tag);
			if (tag === "canvas") created.push(el as HTMLCanvasElement);
			return el;
		}) as typeof document.createElement);

		paint(renderer, cell("A"));
		create.mockRestore();
		expect(created.length).toBe(1);
		expect(created[0].width).toBeGreaterThan(0);

		handle.dispose();

		// Zeroing the size is what frees it now; dropping the reference alone does not.
		expect(created[0].width).toBe(0);
		expect(created[0].height).toBe(0);
	});
});

describe("bounds", () => {
	/** A renderer stub, so the caps can be probed without 32 real CanvasRenderers. */
	function stubRenderer(): AtlasRenderer & { vendorCalls: number } {
		const recorder = recordingCtx();
		return {
			vendorCalls: 0,
			renderCellText() { this.vendorCalls += 1; },
			metrics: { width: 8, height: 17, baseline: 13 },
			fontSize: 13,
			fontFamily: "monospace",
			devicePixelRatio: 2,
			ctx: recorder.ctx,
		} as AtlasRenderer & { vendorCalls: number };
	}

	it("stops making atlases past the style cap instead of growing without bound", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		const ctx = renderer.ctx as never;

		// One distinct colour per cell — the truecolour flood.
		for (let i = 0; i < MAX_STYLES + 10; i++) {
			atlas.draw(renderer, ctx, cell("a", { fg_r: i, fg_g: 0, fg_b: 0 }), 0, 0);
		}

		const stats = atlas.stats();
		expect(stats.styles).toBe(MAX_STYLES);
		// The overflow did not break, it just went the slow way.
		expect(stats.hits).toBe(MAX_STYLES);
		expect(stats.misses).toBe(10);
	});

	it("pages the strip, then stops at the page cap", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		const ctx = renderer.ctx as never;
		const capacity = GLYPHS_PER_PAGE * MAX_PAGES_PER_STYLE;

		for (let i = 0; i < capacity + 5; i++) {
			// Distinct codepoints, one colour: fills pages within a single style.
			atlas.draw(renderer, ctx, cell("", { codepoint: 0x21 + i }), 0, 0);
		}

		const stats = atlas.stats();
		expect(stats.pages).toBe(MAX_PAGES_PER_STYLE);
		expect(stats.rasterised).toBe(capacity);
		expect(stats.misses).toBe(5);
	});

	it("throws away every bitmap when the font metrics change", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		const ctx = renderer.ctx as never;

		atlas.draw(renderer, ctx, cell("a"), 0, 0);
		expect(atlas.stats().rasterised).toBe(1);

		// Zoom: same glyph, new metrics. A stale bitmap would blit at the old size.
		renderer.fontSize = 20;
		renderer.metrics = { width: 11, height: 23, baseline: 18 };
		atlas.draw(renderer, ctx, cell("a"), 0, 0);

		expect(atlas.stats()).toMatchObject({ rasterised: 2, styles: 1 });
	});

	it("defers everything when the renderer has no usable metrics yet", () => {
		const renderer = stubRenderer();
		renderer.metrics = { width: 0, height: 0, baseline: 0 };
		const atlas = createGlyphAtlas();

		expect(atlas.draw(renderer, renderer.ctx as never, cell("a"), 0, 0)).toBe(false);
		expect(atlas.stats().misses).toBe(1);
	});
});

describe("churn detection", () => {
	function stubRenderer(): AtlasRenderer {
		const recorder = recordingCtx();
		return {
			renderCellText() {},
			metrics: { width: 8, height: 17, baseline: 13 },
			fontSize: 13,
			fontFamily: "monospace",
			devicePixelRatio: 2,
			ctx: recorder.ctx,
		} as AtlasRenderer;
	}

	/** A cell whose colour is derived from `n`, so a counter can drive a palette. */
	function colouredCell(n: number) {
		return cell("a", { fg_r: n & 0xff, fg_g: (n >> 8) & 0xff, fg_b: (n >> 16) & 0xff });
	}

	/** Draw `count` cells; `colour(i)` picks the palette entry for cell `i`. */
	function drawCells(
		atlas: ReturnType<typeof createGlyphAtlas>,
		renderer: AtlasRenderer,
		count: number,
		colour: (i: number) => number,
		start = 0,
	): void {
		const ctx = renderer.ctx as never;
		for (let i = start; i < start + count; i++) atlas.draw(renderer, ctx, colouredCell(colour(i)), 0, 0);
	}

	it("leaves a stable palette alone, however long it runs", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();

		// Six windows of a fixed palette that fits — a truecolour theme, not churn.
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 6, (i) => i % (MAX_STYLES / 2));

		expect(atlas.stats().disabled).toBe(false);
		expect(atlas.stats().disableCount).toBe(0);
	});

	it("does not judge the first window, where every colour is legitimately new", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();

		// One window in which every single cell mints a colour: the warm-up.
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS, (i) => i);

		expect(atlas.stats().disabled).toBe(false);
	});

	it("switches itself off once a drifting palette outlives the warm-up", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();

		// Every cell a colour nobody has seen, for two windows.
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);

		const stats = atlas.stats();
		expect(stats.disabled).toBe(true);
		expect(stats.disableCount).toBe(1);
		expect(stats.styles).toBe(0);
	});

	it("hands the pixels back, not just the bookkeeping, when it switches off", () => {
		const renderer = stubRenderer();
		// Real canvas elements, collected: `pageBytes` is a counter and would read
		// zero even if every strip were still holding its backing store.
		const strips: HTMLCanvasElement[] = [];
		const atlas = createGlyphAtlas({
			createCanvas: () => {
				const canvas = document.createElement("canvas");
				strips.push(canvas);
				return canvas;
			},
		});

		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);

		expect(atlas.stats().disabled).toBe(true);
		expect(strips.length).toBeGreaterThan(0);
		// A canvas whose dimensions are zero has released its pixels; one that kept
		// its size is still tens of megabytes the detector claimed to have freed.
		expect(strips.filter((c) => c.width !== 0 || c.height !== 0)).toEqual([]);
		expect(atlas.stats().pageBytes).toBe(0);
	});

	it("keeps refusing while it is off, and hands every cell to the vendor", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);
		expect(atlas.stats().disabled).toBe(true);

		// A cell it would normally love: one colour, one glyph.
		const before = atlas.stats().rasterised;
		const took = atlas.draw(renderer, renderer.ctx as never, cell("a"), 0, 0);

		expect(took).toBe(false);
		// Not zero total — the warm-up window legitimately rasterised — but zero MORE.
		expect(atlas.stats().rasterised).toBe(before);
	});

	it("comes back after the cooldown, and caches again if the screen settled", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);
		expect(atlas.stats().disabled).toBe(true);

		// Ride out the cooldown, then feed it a single well-behaved colour.
		drawCells(atlas, renderer, CHURN_COOLDOWN_CELLS, () => 1);
		drawCells(atlas, renderer, 10, () => 1);

		const stats = atlas.stats();
		expect(stats.disabled).toBe(false);
		expect(stats.rasterised).toBeGreaterThan(0);
	});

	it("re-arms: a palette that drifts again gets switched off again", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);
		drawCells(atlas, renderer, CHURN_COOLDOWN_CELLS, () => 1);

		// Warm-up window is forgiven, the one after it is not.
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i, 1_000_000);

		expect(atlas.stats().disableCount).toBe(2);
	});

	it("stays out of the way entirely when churn detection is switched off", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas({ churnDetection: false });

		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 3, (i) => i);

		expect(atlas.stats().disabled).toBe(false);
		expect(atlas.stats().styles).toBe(MAX_STYLES);
	});

	it("switches off a palette that is stable but larger than the cap", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();

		// Never-changing colours, but more of them than the atlas can hold. Half the
		// screen from cache and half from the vendor is the slowest arrangement of
		// all, so overflowing the cap has to end in a shutdown, not in limping.
		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i % (MAX_STYLES * 2));

		expect(atlas.stats().disabled).toBe(true);
	});

	it("keeps a palette that exactly fills the cap", () => {
		const renderer = stubRenderer();
		const atlas = createGlyphAtlas();

		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 3, (i) => i % MAX_STYLES);

		expect(atlas.stats().disabled).toBe(false);
		expect(atlas.stats().styles).toBe(MAX_STYLES);
	});

	it("counts a colour the cap already rejected as churn, not as a settled screen", () => {
		const renderer = stubRenderer();
		// A cap of one: the second colour onwards can never mint a style, so a
		// detector watching created styles would see a perfectly quiet screen.
		const atlas = createGlyphAtlas({ maxStyles: 1 });

		drawCells(atlas, renderer, CHURN_WINDOW_CELLS * 2, (i) => i);

		expect(atlas.stats().disabled).toBe(true);
	});
});

describe("codepoint predicates", () => {
	it("counts only genuinely empty cells as blank", () => {
		expect(isBlankCodepoint(0)).toBe(true);
		expect(isBlankCodepoint(0x20)).toBe(true);
		expect(isBlankCodepoint(0x41)).toBe(false);
		// A non-breaking space HAS ink rules of its own; leave it to the vendor path.
		expect(isBlankCodepoint(0xa0)).toBe(false);
	});

	it("caches printable BMP codepoints and nothing else", () => {
		expect(isCacheableCodepoint(0x41)).toBe(true);
		expect(isCacheableCodepoint(0xffff)).toBe(true);
		expect(isCacheableCodepoint(0x20)).toBe(false);
		expect(isCacheableCodepoint(0x1f)).toBe(false);
		expect(isCacheableCodepoint(0x7f)).toBe(false);
		expect(isCacheableCodepoint(0x1d518)).toBe(false);
	});
});
