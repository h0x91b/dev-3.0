// Guards that the feature costs nothing on a screen with no right-to-left text,
// and that a full right-to-left screen costs exactly one pass per row. Counts,
// not wall clock — deterministic in CI.
import { CanvasRenderer } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BidiEngine, defaultBidiEngine } from "../engine";
import { installBidiRender } from "../proxy";
import { fakeRenderable, padded, recordingCtx, row } from "./fixtures";

function countingEngine() {
	const real = defaultBidiEngine();
	const getEmbeddingLevels = vi.fn(real.getEmbeddingLevels.bind(real));
	const engine: BidiEngine = {
		getEmbeddingLevels,
		getReorderSegments: real.getReorderSegments.bind(real),
		getReorderedIndices: real.getReorderedIndices.bind(real),
		getMirroredCharactersMap: real.getMirroredCharactersMap.bind(real),
		getBidiCharTypeName: real.getBidiCharTypeName.bind(real),
	};
	return {
		engine,
		calls: () => getEmbeddingLevels.mock.calls.length,
		reset: () => getEmbeddingLevels.mockClear(),
	};
}

const ROWS = 24;
const COLS = 200;

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

function screen(text: string) {
	return Array.from({ length: ROWS }, () => padded(row(text), COLS));
}

/** Paints two frames and leaves only the SECOND frame's counters behind: frame
 *  one always resizes the canvas, which forces an unrepresentative full redraw. */
function paint(rows: ReturnType<typeof screen>, control?: ReturnType<typeof countingEngine>) {
	const renderer = new CanvasRenderer(document.createElement("canvas"), {
		fontSize: 15,
		fontFamily: "monospace",
		cursorBlink: false,
		devicePixelRatio: 1,
	});
	if (control) installBidiRender(renderer, control.engine);
	const buffer = fakeRenderable(rows, COLS, { x: 5, y: 3, visible: true });
	renderer.render(buffer, true, 0, undefined, 0);
	ops.length = 0;
	control?.reset();
	renderer.render(buffer, true, 0, undefined, 0);
}

describe("bidi fast path", () => {
	it("never calls the bidi engine on an all-ascii screen", () => {
		const control = countingEngine();
		paint(screen("$ ls -la /tmp && echo done"), control);
		expect(control.calls()).toBe(0);
	});

	it("never calls the bidi engine on a russian or CJK screen", () => {
		const control = countingEngine();
		paint(screen("Привет мир 日本語 текст"), control);
		expect(control.calls()).toBe(0);
	});

	it("runs exactly one pass per row on an all-hebrew screen", () => {
		const control = countingEngine();
		paint(screen("שלום עולם"), control);
		// One per row and no second pass for the cursor's row.
		expect(control.calls()).toBe(ROWS);
	});

	it("produces an identical op log with and without the proxy on ascii", () => {
		paint(screen("$ ls -la /tmp"));
		const plain = ops.map((op) => `${op.op}(${op.args.join(",")})`);
		ops.length = 0;

		const control = countingEngine();
		paint(screen("$ ls -la /tmp"), control);
		const wrapped = ops.map((op) => `${op.op}(${op.args.join(",")})`);

		expect(wrapped.length).toBe(plain.length);
		expect(wrapped).toEqual(plain);
	});
});
