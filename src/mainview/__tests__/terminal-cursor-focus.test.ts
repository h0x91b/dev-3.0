// Drives ghostty-web's REAL CanvasRenderer through the gate with a recording 2D
// context, so "the cursor is hidden" is asserted as pixels not painted rather
// than as our own flag. Bar cursor at cell width 10 is a 2px-wide fillRect,
// which nothing else in a frame produces — that is the marker used below.
import { CanvasRenderer } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBidiRender, uninstallBidiRender } from "../terminal-bidi/proxy";
import { fakeRenderable, padded, recordingCtx, row } from "../terminal-bidi/__tests__/fixtures";
import { installCursorVisibilityGate, isCursorVisibilityGateInstalled } from "../terminal-cursor-focus";

const CELL_WIDTH = 10;
const CELL_HEIGHT = 17;
const CURSOR_COLOR = "#ff00ff";

let ops: ReturnType<typeof recordingCtx>["ops"];
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	const recorder = recordingCtx();
	ops = recorder.ops;
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
		cursorStyle: "bar",
		devicePixelRatio: 1,
		theme: { cursor: CURSOR_COLOR },
	});
}

/** Every bar-cursor rect painted this frame, as {x, y} cell coordinates. */
function cursorRects(): { x: number; y: number }[] {
	return ops
		.filter((op) => op.op === "fillRect" && op.args[2] === 2 && op.fillStyle === CURSOR_COLOR)
		.map((op) => ({
			x: Number(op.args[0]) / CELL_WIDTH,
			y: Number(op.args[1]) / CELL_HEIGHT,
		}));
}

function grid() {
	return fakeRenderable([padded(row("ok"), 4)], 4, { x: 2, y: 0, visible: true });
}

describe("terminal cursor visibility gate", () => {
	it("paints the cursor while the terminal has input", () => {
		const renderer = newRenderer();
		const gate = installCursorVisibilityGate(renderer);
		gate.setCursorVisible(true);

		renderer.render(grid(), true, 0);

		expect(cursorRects()).toEqual([{ x: 2, y: 0 }]);
	});

	it("paints no cursor once input goes elsewhere", () => {
		const renderer = newRenderer();
		const gate = installCursorVisibilityGate(renderer);
		gate.setCursorVisible(false);

		renderer.render(grid(), true, 0);

		expect(cursorRects()).toEqual([]);
	});

	it("keeps painting the row's text with the cursor hidden", () => {
		const renderer = newRenderer();
		installCursorVisibilityGate(renderer).setCursorVisible(false);

		renderer.render(grid(), true, 0);

		const glyphs = ops.filter((op) => op.op === "fillText").map((op) => String(op.args[0]));
		expect(glyphs.join("")).toContain("ok");
	});

	it("restores the vendor cursor on dispose", () => {
		const renderer = newRenderer();
		const gate = installCursorVisibilityGate(renderer);
		gate.setCursorVisible(false);
		gate.dispose();

		renderer.render(grid(), true, 0);

		expect(isCursorVisibilityGateInstalled(renderer)).toBe(false);
		expect(cursorRects()).toEqual([{ x: 2, y: 0 }]);
	});

	// The bidi settings toggle restores whatever render it wrapped, so a gate
	// installed on top of bidi would be silently removed by turning bidi off.
	it("survives the bidi render toggle", () => {
		const renderer = newRenderer();
		const gate = installCursorVisibilityGate(renderer);
		gate.setCursorVisible(false);
		installBidiRender(renderer);
		uninstallBidiRender(renderer);

		renderer.render(grid(), true, 0);

		expect(isCursorVisibilityGateInstalled(renderer)).toBe(true);
		expect(cursorRects()).toEqual([]);
	});

	it("hides the cursor with bidi installed on top", () => {
		const renderer = newRenderer();
		const gate = installCursorVisibilityGate(renderer);
		installBidiRender(renderer);
		gate.setCursorVisible(false);

		renderer.render(grid(), true, 0);

		expect(cursorRects()).toEqual([]);
	});
});

// Issue #1949: with blinking on, the vendor repainted the cursor's row on every
// frame. The gate keeps that repaint only for frames whose drawn cursor changes.
describe("terminal cursor row repaint with blinking on", () => {
	type BlinkingRenderer = CanvasRenderer;
	const blinkEnabled = (renderer: CanvasRenderer) => (renderer as unknown as { cursorBlink: boolean }).cursorBlink;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function blinkingRenderer(): BlinkingRenderer {
		return new CanvasRenderer(document.createElement("canvas"), {
			fontSize: 15,
			fontFamily: "monospace",
			cursorBlink: true,
			cursorStyle: "bar",
			devicePixelRatio: 1,
			theme: { cursor: CURSOR_COLOR },
		});
	}

	/** An idle screen: nothing dirty, so only the cursor logic can repaint a row. */
	function idleGrid(cursor = { x: 2, y: 0, visible: true }) {
		return { ...fakeRenderable([padded(row("ok"), 4), padded(row("hi"), 4)], 4, cursor), isRowDirty: (_y: number): boolean => false };
	}

	function frame(renderer: BlinkingRenderer, buffer: ReturnType<typeof idleGrid>) {
		ops.length = 0;
		renderer.render(buffer, false, 0);
		return {
			glyphs: ops.filter((op) => op.op === "fillText").map((op) => String(op.args[0])).join(""),
			cursor: cursorRects(),
		};
	}

	it("does not repaint the cursor row on idle frames", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		const buffer = idleGrid();

		expect(frame(renderer, buffer).cursor).toEqual([{ x: 2, y: 0 }]);
		// On WebKitGTK any draw call repaints the canvas, so an idle frame issues none.
		for (let i = 0; i < 5; i++) {
			frame(renderer, buffer);
			expect(ops.filter((op) => op.op === "fillRect" || op.op === "fillText")).toEqual([]);
		}
		expect(blinkEnabled(renderer)).toBe(true);
	});

	it("redraws the cursor when its row was repainted for new output", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		frame(renderer, buffer);
		frame(renderer, buffer);

		const dirty = frame(renderer, { ...buffer, isRowDirty: (y: number): boolean => y === 0 });

		expect(dirty.glyphs).toContain("ok");
		expect(dirty.cursor).toEqual([{ x: 2, y: 0 }]);
	});

	it("redraws the cursor on the frame after a scrollbar pass", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		const scrollback = { getScrollbackLength: () => 10, getScrollbackLine: () => null };
		frame(renderer, buffer);
		frame(renderer, buffer);

		ops.length = 0;
		renderer.render(buffer, false, 0, scrollback, 1);

		expect(frame(renderer, buffer).cursor).toEqual([{ x: 2, y: 0 }]);
		expect(frame(renderer, buffer).cursor).toEqual([]);
	});

	it("hands the draw calls back to the vendor on dispose", () => {
		const renderer = blinkingRenderer();
		const gate = installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		frame(renderer, buffer);
		gate.dispose();

		expect(frame(renderer, buffer).cursor).toEqual([{ x: 2, y: 0 }]);
		expect(frame(renderer, buffer).cursor).toEqual([{ x: 2, y: 0 }]);
	});

	it("repaints the row when the blink phase hides and shows the cursor", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		frame(renderer, buffer);
		frame(renderer, buffer);

		vi.advanceTimersByTime(530);
		const hidden = frame(renderer, buffer);
		expect(hidden.glyphs).toContain("ok");
		expect(hidden.cursor).toEqual([]);
		expect(frame(renderer, buffer).glyphs).toBe("");

		vi.advanceTimersByTime(530);
		const shown = frame(renderer, buffer);
		expect(shown.glyphs).toContain("ok");
		expect(shown.cursor).toEqual([{ x: 2, y: 0 }]);
	});

	it("erases the cursor on the first frame after input leaves, and redraws it on return", () => {
		const renderer = blinkingRenderer();
		const gate = installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		frame(renderer, buffer);
		frame(renderer, buffer);

		gate.setCursorVisible(false);
		const blurred = frame(renderer, buffer);
		expect(blurred.glyphs).toContain("ok");
		expect(blurred.cursor).toEqual([]);
		expect(frame(renderer, buffer).glyphs).toBe("");

		gate.setCursorVisible(true);
		const focused = frame(renderer, buffer);
		expect(focused.glyphs).toContain("ok");
		expect(focused.cursor).toEqual([{ x: 2, y: 0 }]);
	});

	it("still repaints both rows when the cursor moves", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		frame(renderer, idleGrid());
		frame(renderer, idleGrid());

		const moved = frame(renderer, idleGrid({ x: 1, y: 1, visible: true }));

		expect(moved.glyphs).toContain("ok");
		expect(moved.glyphs).toContain("hi");
		expect(moved.cursor).toEqual([{ x: 1, y: 1 }]);
	});

	it("restores cursorBlink when a frame throws", () => {
		const renderer = blinkingRenderer();
		installCursorVisibilityGate(renderer);
		const buffer = idleGrid();
		frame(renderer, buffer);
		const broken = { ...buffer, getDimensions: () => { throw new Error("boom"); } };

		expect(() => renderer.render(broken, false, 0)).toThrow("boom");
		expect(blinkEnabled(renderer)).toBe(true);
		expect(frame(renderer, buffer).glyphs).toContain("ok");
	});
});
