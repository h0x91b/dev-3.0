// Drives ghostty-web's REAL CanvasRenderer, so the assertions are about the
// geometry a glyph actually lands on rather than about our own abstractions.
//
// The stub font in `recordingCtx` reproduces both halves of the vendor's bug:
// an "M" whose ink is 12 + 3 = 15 tall inside a line box of 14 + 4 = 18, and an
// advance of 9.5 under a cell width of ceil(9.5) = 10. The vendor's own formulas
// therefore give a 10 x 17 cell with the baseline at 13.
import { CanvasRenderer, type GhosttyCell } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cell, fakeRenderable, padded, recordingCtx } from "../terminal-bidi/__tests__/fixtures";
import {
	clearGlyphCellFitCache,
	installGlyphCellFit,
	isGlyphCellFitInstalled,
} from "../terminal-glyph-cell-fit";

const CELL_WIDTH = 10;
const CELL_HEIGHT = 17;
const BASELINE = 13;
const ADVANCE = 9.5;
const INK_HEIGHT = 15;
const LINE_BOX_HEIGHT = 18;

let ops: ReturnType<typeof recordingCtx>["ops"];
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	clearGlyphCellFitCache();
	const recorder = recordingCtx();
	ops = recorder.ops;
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockImplementation(() => recorder.ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
	getContextSpy.mockRestore();
});

/** Paint one row containing `cells`, with the fit installed unless told otherwise. */
function paint(cells: GhosttyCell[], { fit = true } = {}) {
	const renderer = new CanvasRenderer(document.createElement("canvas"), {
		fontSize: 15,
		fontFamily: "monospace",
		cursorBlink: false,
		devicePixelRatio: 1,
	});
	if (fit) installGlyphCellFit(renderer);
	const buffer = fakeRenderable([padded(cells, cells.length)], cells.length);
	// Frame 1 resizes the canvas and forces a full redraw; assert on frame 2.
	renderer.render(buffer, true, 0, undefined, 0);
	ops.length = 0;
	renderer.render(buffer, true, 0, undefined, 0);
	return renderer;
}

/** The op names between the glyph's `save` and its `restore`, plus their args. */
function glyphOps() {
	const drawn = ops.map((op) => ({ op: op.op, args: op.args as number[] }));
	const start = drawn.findIndex((op) => op.op === "save");
	if (start < 0) return drawn.filter((op) => op.op === "fillText");
	const end = drawn.findIndex((op, index) => index > start && op.op === "restore");
	return drawn.slice(start, end + 1);
}

function argsOf(name: string): number[] {
	const found = ops.find((op) => op.op === name);
	if (!found) throw new Error(`no ${name} recorded`);
	return found.args as number[];
}

describe("glyph-cell fit", () => {
	it("leaves ordinary text on the vendor's path", () => {
		paint([cell("A")]);
		expect(ops.some((op) => op.op === "clip")).toBe(false);
		expect(argsOf("fillText").slice(1)).toEqual([0, BASELINE]);
	});

	it("clips a full block to the cell box and grows its ink one device pixel past it", () => {
		paint([cell("█")]);
		const sequence = glyphOps().map((op) => op.op);
		expect(sequence).toEqual([
			"save",
			"rect",
			"clip",
			"translate",
			"scale",
			"translate",
			"fillText",
			"restore",
		]);
		// The clip is exactly the box `renderCellBackground` fills.
		expect(argsOf("rect")).toEqual([0, 0, CELL_WIDTH, CELL_HEIGHT]);
		// One device pixel of overshoot per edge, cut back by the clip: landing the
		// measured ink exactly on the edge leaves the last device row part-covered.
		expect(argsOf("scale")).toEqual([(CELL_WIDTH + 2) / ADVANCE, (CELL_HEIGHT + 2) / INK_HEIGHT]);
	});

	it("scales the overshoot with the device pixel ratio", () => {
		const recorder = recordingCtx();
		recorder.ctx.getTransform = () => ({ a: 2, d: 2 });
		getContextSpy.mockImplementation(() => recorder.ctx as unknown as CanvasRenderingContext2D);
		ops = recorder.ops;
		paint([cell("█")]);
		// A device pixel is half a CSS pixel at dpr 2, so the overshoot halves.
		expect(argsOf("scale")).toEqual([(CELL_WIDTH + 1) / ADVANCE, (CELL_HEIGHT + 1) / INK_HEIGHT]);
	});

	it("fits partial glyphs by the line box, with no overshoot to distort them", () => {
		paint([cell("│")]);
		expect(argsOf("scale")).toEqual([CELL_WIDTH / ADVANCE, CELL_HEIGHT / LINE_BOX_HEIGHT]);
		expect(argsOf("translate")[0]).toBe(0);
	});

	it("puts the glyph's top edge on the cell's top edge", () => {
		paint([cell("│")]);
		// The vendor draws at y = baseline; after the fit that maps to the top of the
		// cell, because the source box's own top is what got scaled onto it.
		const scaleY = CELL_HEIGHT / LINE_BOX_HEIGHT;
		const lineBoxAscent = 14;
		const [, offsetY] = argsOf("translate");
		expect(offsetY).toBeCloseTo((lineBoxAscent - BASELINE) * scaleY, 6);
		// Composed, the vendor's own y = BASELINE lands the box top on the cell top.
		expect(offsetY + BASELINE * scaleY - lineBoxAscent * scaleY).toBeCloseTo(0, 6);
	});

	it("does not touch a wide cell or a multi-codepoint grapheme", () => {
		paint([cell("█", { width: 2 }), cell("", { codepoint: 0, width: 0 })]);
		expect(ops.some((op) => op.op === "clip")).toBe(false);
		paint([cell("█", { grapheme_len: 1 })]);
		expect(ops.some((op) => op.op === "clip")).toBe(false);
	});

	it("installs once and restores the vendor's painting on dispose", () => {
		const renderer = paint([cell("█")]);
		expect(isGlyphCellFitInstalled(renderer)).toBe(true);
		const second = installGlyphCellFit(renderer);
		second.dispose();
		expect(isGlyphCellFitInstalled(renderer)).toBe(false);

		const buffer = fakeRenderable([[cell("█")]], 1);
		ops.length = 0;
		renderer.render(buffer, true, 0, undefined, 0);
		expect(ops.some((op) => op.op === "clip")).toBe(false);
	});
});
