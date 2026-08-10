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
