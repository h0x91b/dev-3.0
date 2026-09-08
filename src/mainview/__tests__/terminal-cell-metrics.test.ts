// Drives ghostty-web's REAL CanvasRenderer, so the cell the terminal actually
// grids on is what is asserted — not our own abstraction over it.
//
// The stub font in `recordingCtx` carries the vendor's bug: an "M" whose ink is
// 12 + 3 = 15 tall inside a line box of 14 + 4 = 18. The vendor's formula
// (`ceil(ink) + 2`) therefore gives a 17px cell with the baseline at 13, and the
// font's designed 18px line box never enters it.
import { CanvasRenderer } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingCtx } from "../terminal-bidi/__tests__/fixtures";
import {
	clearCellMetricsCache,
	installCellLineBox,
	isCellLineBoxInstalled,
	lineBoxCell,
} from "../terminal-cell-metrics";

const VENDOR_HEIGHT = 17;
const VENDOR_BASELINE = 13;
const LINE_BOX_HEIGHT = 18;
const LINE_BOX_BASELINE = 14;
const CELL_WIDTH = 10;

let getContextSpy: ReturnType<typeof vi.spyOn>;

function stubContext(ctx: Record<string, unknown>) {
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
}

beforeEach(() => {
	clearCellMetricsCache();
	stubContext(recordingCtx().ctx);
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

describe("lineBoxCell", () => {
	it("takes the font's designed line box, ascent and descent each ceiled", () => {
		// JetBrains Mono at size 16, as both Chromium and WKWebView report it.
		expect(lineBoxCell({ fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 5 } as TextMetrics))
			.toEqual({ height: 21, baseline: 16 });
	});

	it("ceils each side separately, so neither ascent nor descent is cropped", () => {
		// The same font's unrounded metrics: 1020/1000 and 300/1000 of 16px.
		expect(lineBoxCell({ fontBoundingBoxAscent: 16.32, fontBoundingBoxDescent: 4.8 } as TextMetrics))
			.toEqual({ height: 22, baseline: 17 });
	});

	it("keeps a legitimate zero descent instead of substituting a guess", () => {
		expect(lineBoxCell({ fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 0 } as TextMetrics))
			.toEqual({ height: 14, baseline: 14 });
	});

	it("refuses a measurement it cannot use", () => {
		expect(lineBoxCell({} as TextMetrics)).toBeNull();
		expect(lineBoxCell({ fontBoundingBoxAscent: Number.NaN, fontBoundingBoxDescent: 4 } as TextMetrics)).toBeNull();
		expect(lineBoxCell({ fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 4 } as TextMetrics)).toBeNull();
		expect(lineBoxCell({ fontBoundingBoxAscent: 16, fontBoundingBoxDescent: -2 } as TextMetrics)).toBeNull();
	});
});

describe("installCellLineBox", () => {
	it("the vendor's own cell ignores the font's line box", () => {
		const metrics = newRenderer().getMetrics();
		expect(metrics.height).toBe(VENDOR_HEIGHT);
		expect(metrics.baseline).toBe(VENDOR_BASELINE);
	});

	it("replaces the cell height and baseline with the font's line box", () => {
		const renderer = newRenderer();
		installCellLineBox(renderer);
		const metrics = renderer.getMetrics();
		expect(metrics.height).toBe(LINE_BOX_HEIGHT);
		expect(metrics.baseline).toBe(LINE_BOX_BASELINE);
	});

	it("leaves the cell width on the vendor's ceil of the advance", () => {
		const renderer = newRenderer();
		installCellLineBox(renderer);
		expect(renderer.getMetrics().width).toBe(CELL_WIDTH);
	});

	it("re-applies itself when the font changes", () => {
		const renderer = newRenderer();
		installCellLineBox(renderer);
		renderer.setFontSize(20);
		// The stub font reports the same box at any size; what matters is that the
		// vendor's remeasure did not put its own formula back.
		expect(renderer.getMetrics().height).toBe(LINE_BOX_HEIGHT);
	});

	it("restores the vendor's cell on dispose, and survives a second dispose", () => {
		const renderer = newRenderer();
		const handle = installCellLineBox(renderer);
		expect(isCellLineBoxInstalled(renderer)).toBe(true);
		handle.dispose();
		expect(isCellLineBoxInstalled(renderer)).toBe(false);
		expect(renderer.getMetrics().height).toBe(VENDOR_HEIGHT);
		expect(renderer.getMetrics().baseline).toBe(VENDOR_BASELINE);
		handle.dispose();
		expect(renderer.getMetrics().height).toBe(VENDOR_HEIGHT);
	});

	it("installs once, so a second install cannot stack a wrapper", () => {
		const renderer = newRenderer();
		const first = installCellLineBox(renderer);
		installCellLineBox(renderer);
		first.dispose();
		expect(isCellLineBoxInstalled(renderer)).toBe(false);
		expect(renderer.getMetrics().height).toBe(VENDOR_HEIGHT);
	});

	it("keeps the vendor's cell when the engine reports no line box", () => {
		getContextSpy.mockRestore();
		const recorder = recordingCtx();
		// An engine that answers measureText without the fontBoundingBox fields.
		recorder.ctx.measureText = () => ({ width: 9.5, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 });
		stubContext(recorder.ctx);
		const renderer = newRenderer();
		installCellLineBox(renderer);
		expect(renderer.getMetrics().height).toBe(VENDOR_HEIGHT);
		expect(renderer.getMetrics().baseline).toBe(VENDOR_BASELINE);
	});
});
