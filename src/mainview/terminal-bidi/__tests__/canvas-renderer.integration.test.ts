// Drives ghostty-web's REAL CanvasRenderer through the proxy with a recording
// 2D context, so the assertions are about pixels-worth of geometry rather than
// about our own abstractions. This is the test that would catch a wrong
// assumption about how the vendor consumes the buffer.
import { CanvasRenderer, type GhosttyCell } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBidiRender, uninstallBidiRender } from "../proxy";
import { blank, cell, fakeRenderable, padded, recordingCtx, row } from "./fixtures";

// measureText below yields cell width 10, height ceil(12+3)+2 = 17, baseline 13.
const CELL_WIDTH = 10;
const CELL_HEIGHT = 17;
const BASELINE = 13;

let ops: ReturnType<typeof recordingCtx>["ops"];
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	const recorder = recordingCtx();
	ops = recorder.ops;
	// happy-dom returns null from getContext, and measureFont() creates its own
	// canvas — so the stub has to live on the prototype.
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockImplementation(() => recorder.ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
	getContextSpy.mockRestore();
});

function newRenderer() {
	return new CanvasRenderer(document.createElement("canvas"), {
		fontSize: 15,
		fontFamily: "monospace",
		cursorBlink: false,
		devicePixelRatio: 1,
	});
}

/** Glyphs actually painted, in ascending screen-x order, for one row. */
function glyphsOnRow(rowIndex: number): { x: number; text: string }[] {
	return ops
		.filter((op) => op.op === "fillText" && op.args[2] === rowIndex * CELL_HEIGHT + BASELINE)
		.map((op) => ({ x: op.args[1] as number, text: String(op.args[0]) }))
		.sort((a, b) => a.x - b.x);
}

function paintOnce(rows: GhosttyCell[][], cols: number, bidi: boolean) {
	const renderer = newRenderer();
	if (bidi) installBidiRender(renderer);
	const buffer = fakeRenderable(rows, cols);
	// Frame 1 always resizes the canvas and forces a full redraw; assert on frame 2.
	renderer.render(buffer, true, 0, undefined, 0);
	ops.length = 0;
	renderer.render(buffer, true, 0, undefined, 0);
	return renderer;
}

describe("CanvasRenderer with the bidi proxy installed", () => {
	it("paints a mixed row in visual order at the right columns", () => {
		paintOnce([padded(row("abc שלום def"), 20)], 20, true);

		const glyphs = glyphsOnRow(0);
		expect(glyphs.map((g) => g.text).join("").trimEnd()).toBe("abc םולש def");
		glyphs.forEach((glyph, column) => {
			expect(glyph.x).toBe(column * CELL_WIDTH);
		});
	});

	it("paints an all-latin screen identically with and without the proxy", () => {
		const rows = () => [
			padded(row("$ ls -la /tmp"), 20),
			padded(row("total 42"), 20),
			padded(row("┌────┬────┐"), 20),
		];

		paintOnce(rows(), 20, false);
		const plain = ops.map((op) => `${op.op}(${op.args.join(",")})|${op.fillStyle}`);
		ops.length = 0;

		paintOnce(rows(), 20, true);
		const wrapped = ops.map((op) => `${op.op}(${op.args.join(",")})|${op.fillStyle}`);

		expect(wrapped).toEqual(plain);
	});

	it("skips zero-width spacer cells, so a wide glyph paints once", () => {
		paintOnce([padded(row("日本 שלום"), 20)], 20, true);

		const glyphs = glyphsOnRow(0);
		expect(glyphs.filter((g) => g.text === "日")).toHaveLength(1);
		// The wide pair still occupies two columns: the next glyph is 2 cells over.
		expect(glyphs[1].x - glyphs[0].x).toBe(2 * CELL_WIDTH);
		expect(glyphs.map((g) => g.text).join("").trimEnd()).toBe("日本 םולש");
	});

	it("clears the whole row before painting it", () => {
		paintOnce([padded(row("שלום"), 20)], 20, true);

		const clears = ops.filter(
			(op) =>
				op.op === "fillRect" &&
				op.args[0] === 0 &&
				op.args[1] === 0 &&
				op.args[2] === 20 * CELL_WIDTH &&
				op.args[3] === CELL_HEIGHT,
		);
		expect(clears).toHaveLength(1);
	});

	it("draws the cursor under the glyph the user is actually on", () => {
		const renderer = newRenderer();
		installBidiRender(renderer);
		// Logical column 0 of "שלום" is the rightmost glyph of the run.
		const buffer = fakeRenderable([padded(row("שלום"), 20)], 20, {
			x: 0,
			y: 0,
			visible: true,
		});
		renderer.render(buffer, true, 0, undefined, 0);
		ops.length = 0;
		renderer.render(buffer, true, 0, undefined, 0);

		const cursor = ops.filter(
			(op) => op.op === "fillRect" && op.args[3] === CELL_HEIGHT && op.args[0] === 3 * CELL_WIDTH,
		);
		expect(cursor.length).toBeGreaterThan(0);
	});

	it("resolves grapheme text through the logical column", () => {
		const renderer = newRenderer();
		installBidiRender(renderer);
		const cells = padded(
			[cell("ש", { grapheme_len: 2 }), cell("ל", { grapheme_len: 2 }), blank()],
			10,
		);
		const grapheme = vi.fn((_row: number, col: number) => (col === 0 ? "שָ" : "לַ"));
		const buffer = { ...fakeRenderable([cells], 10), getGraphemeString: grapheme };

		renderer.render(buffer, true, 0, undefined, 0);
		ops.length = 0;
		renderer.render(buffer, true, 0, undefined, 0);

		// Visual column 0 holds logical column 1, so that is what gets looked up.
		expect(grapheme).toHaveBeenCalledWith(0, 1);
		expect(glyphsOnRow(0)[0].text).toBe("לַ");
	});

	it("reorders scrollback rows while scrolled back", () => {
		const renderer = newRenderer();
		installBidiRender(renderer);
		const history = [padded(row("שלום"), 20)];
		const buffer = fakeRenderable([padded(row("prompt"), 20)], 20);
		const scrollback = {
			getScrollbackLine: (offset: number) => history[offset] ?? null,
			getScrollbackLength: () => history.length,
		};

		renderer.render(buffer, true, 1, scrollback, 0);
		ops.length = 0;
		renderer.render(buffer, true, 1, scrollback, 0);

		expect(glyphsOnRow(0).map((g) => g.text).join("").trimEnd()).toBe("םולש");
	});

	it("goes back to logical order after uninstalling", () => {
		const renderer = newRenderer();
		installBidiRender(renderer);
		const buffer = fakeRenderable([padded(row("שלום"), 20)], 20);
		renderer.render(buffer, true, 0, undefined, 0);

		uninstallBidiRender(renderer);
		ops.length = 0;
		renderer.render(buffer, true, 0, undefined, 0);

		expect(glyphsOnRow(0).map((g) => g.text).join("").trimEnd()).toBe("שלום");
	});
});
