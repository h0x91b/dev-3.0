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
	deviceGridWidth,
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

function newRenderer(devicePixelRatio = 1) {
	return new CanvasRenderer(document.createElement("canvas"), {
		fontSize: 15,
		fontFamily: "monospace",
		cursorBlink: false,
		devicePixelRatio,
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

describe("deviceGridWidth", () => {
	it("quantizes on the device grid, which on a 1x display is just whole CSS pixels", () => {
		// JetBrains Mono at size 16: advance 9.6.
		expect(deviceGridWidth(9.6, 1)).toBe(10);
		expect(deviceGridWidth(8.4, 1)).toBe(8);
	});

	it("gives a half CSS pixel on a 2x display — a whole device pixel", () => {
		// 9.6 x 2 = 19.2 device px, rounded to 19, which is Ghostty's 9.5 CSS px.
		expect(deviceGridWidth(9.6, 2)).toBe(9.5);
		expect(deviceGridWidth(8.4, 2)).toBe(8.5);
	});

	it("never collapses a cell to zero", () => {
		expect(deviceGridWidth(0.2, 1)).toBe(1);
		expect(deviceGridWidth(0.1, 2)).toBe(0.5);
	});

	it("holds the reference clamp where the vendor's ceil breaks it", () => {
		// The measured case: Hack at user size 15 lands on 8.9946 in Chromium and
		// 9.0001 in WKWebView, and `ceil` splits those into 9 and 10 — wider than the
		// reference font's own cell. Quantizing agrees with itself and with the
		// reference across that hair.
		const reference = deviceGridWidth(9, 2);
		expect(deviceGridWidth(8.9946, 2)).toBe(reference);
		expect(deviceGridWidth(9.0001, 2)).toBe(reference);
		expect(Math.ceil(8.9946)).not.toBe(Math.ceil(9.0001));
	});

	it("refuses what it cannot use, so the caller can fall back", () => {
		expect(deviceGridWidth(Number.NaN, 2)).toBeNull();
		expect(deviceGridWidth(0, 2)).toBeNull();
		expect(deviceGridWidth(9.6, 0)).toBeNull();
		expect(deviceGridWidth(9.6, undefined)).toBeNull();
		expect(deviceGridWidth(9.6, Number.NaN)).toBeNull();
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

	it("replaces the vendor's ceiled width with the device-grid width", () => {
		// The stub advance is 9.5, which the vendor ceils to 10.
		expect(newRenderer().getMetrics().width).toBe(CELL_WIDTH);
		const renderer = newRenderer();
		installCellLineBox(renderer);
		expect(renderer.getMetrics().width).toBe(10); // round(9.5) at ratio 1
	});

	it("lands on a half CSS pixel at a 2x ratio, matching Ghostty", () => {
		const renderer = newRenderer(2);
		installCellLineBox(renderer);
		// 9.5 x 2 = 19 device px exactly, so the CSS width stays 9.5 rather than 10.
		expect(renderer.getMetrics().width).toBe(9.5);
	});

	it("reads the renderer's own ratio, not the window's", () => {
		const original = window.devicePixelRatio;
		Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
		try {
			const renderer = newRenderer(2);
			installCellLineBox(renderer);
			// A window ratio of 3 would give round(9.5 * 3) / 3 = 9.333…
			expect(renderer.getMetrics().width).toBe(9.5);
		} finally {
			Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
		}
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
